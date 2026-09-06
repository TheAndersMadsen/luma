use super::*;
use std::sync::{Condvar, mpsc as sync_mpsc};

static CLIENT_TEST: Mutex<()> = Mutex::new(());

fn public_config() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "version": 1,
        "serverOrigin": "https://ffi.example",
        "enrollmentId": "BE0FB1CB-239D-45B3-AF80-482735D5C060",
        "platform": "macos",
        "bootEpoch": "F0E63872-4893-43A4-9C50-338E50BD5B54",
    }))
    .unwrap()
}

unsafe extern "C" fn missing(_: *mut c_void, _: *mut u8, _: usize, written: *mut usize) -> i32 {
    unsafe {
        *written = 0;
    }
    1
}

unsafe extern "C" fn rejected_signature(
    _: *mut c_void,
    _: *const u8,
    _: usize,
    _: *mut u8,
    _: usize,
    _: *mut usize,
) -> i32 {
    -1
}

unsafe extern "C" fn rejected_write(_: *mut c_void, _: *const u8, _: usize) -> i32 {
    -1
}

fn callbacks(read: ReadCallback, context: *mut c_void) -> CosmosSurfaceCallbacks {
    CosmosSurfaceCallbacks {
        context,
        public_key: Some(read),
        sign_sha256: Some(rejected_signature),
        read_journal: Some(missing),
        write_journal_atomically: Some(rejected_write),
    }
}

#[test]
fn public_configuration_accepts_swift_uuid_case_and_rejects_authority_fields() {
    let bytes = public_config();
    let parsed = config(&bytes).unwrap();
    assert_eq!(
        parsed.enrollment_id.to_string(),
        "be0fb1cb-239d-45b3-af80-482735d5c060"
    );
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    value["sessionToken"] = json!("must never become public configuration");
    assert!(config(&serde_json::to_vec(&value).unwrap()).is_err());
    value.as_object_mut().unwrap().remove("sessionToken");
    value["bootEpoch"] = json!(Uuid::nil().to_string());
    assert!(config(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn failed_create_clears_the_output_without_retaining_callback_context() {
    let mut output = ptr::dangling_mut::<CosmosSurface>();
    let callback = callbacks(missing, ptr::null_mut());
    assert_eq!(
        unsafe { cosmos_surface_create(b"{}".as_ptr(), 2, &callback, &mut output) },
        INVALID_ARGUMENT
    );
    assert!(output.is_null());
    assert_eq!(unsafe { cosmos_surface_destroy(output) }, OK);
    assert_eq!(boundary(|| panic!("synthetic boundary panic")), PANIC);
}

#[test]
fn callback_lengths_and_missing_journal_are_checked_before_reading_bytes() {
    let callback = Callbacks(callbacks(missing, ptr::null_mut()));
    assert!(callback.load().unwrap().is_none());
    assert!(callback.public_key_sec1().is_err());
    assert!(callback.save_atomically(&[]).is_err());
    unsafe extern "C" fn oversized(
        _: *mut c_void,
        _: *mut u8,
        capacity: usize,
        written: *mut usize,
    ) -> i32 {
        unsafe {
            *written = capacity + 1;
        }
        OK
    }
    let mut functions = callbacks(oversized, ptr::null_mut());
    functions.read_journal = Some(oversized);
    let callback = Callbacks(functions);
    assert!(callback.public_key_sec1().is_err());
    assert!(callback.load().is_err());
}

fn queued_handle() -> (Box<CosmosSurface>, mpsc::Receiver<Command>) {
    let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (shutdown, _) = watch::channel(false);
    (
        Box::new(CosmosSurface {
            commands,
            shutdown,
            events: Arc::new(Mutex::new(Events::default())),
            speech_audio: Arc::new(Mutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
            callbacks_finished: Mutex::new(None),
            worker: None,
        }),
        receiver,
    )
}

#[test]
fn queues_are_bounded_and_short_poll_does_not_consume_the_snapshot() {
    let (mut handle, _receiver) = queued_handle();
    for _ in 0..COMMAND_CAPACITY {
        assert_eq!(handle.enqueue(Command::Connect), OK);
    }
    assert_eq!(handle.enqueue(Command::Connect), QUEUE_FULL);
    for _ in 0..EVENT_CAPACITY + 2 {
        push(
            &handle.events,
            snapshot(None, &Value::Null, "prepare", None),
        );
    }
    assert_eq!(
        handle.events.lock().unwrap().snapshots.len(),
        EVENT_CAPACITY
    );
    let mut required = 0;
    let pointer = (&mut *handle) as *mut CosmosSurface;
    assert_eq!(
        unsafe { cosmos_surface_poll(pointer, ptr::null_mut(), 0, &mut required) },
        BUFFER_TOO_SMALL
    );
    assert!(required > 0 && required <= MAX_EVENT);
    let mut bytes = [0u8; MAX_EVENT];
    assert_eq!(
        unsafe { cosmos_surface_poll(pointer, bytes.as_mut_ptr(), bytes.len(), &mut required) },
        OK
    );
    let snapshot: Value = serde_json::from_slice(&bytes[..required]).unwrap();
    assert_eq!(snapshot["kind"], "state");
    assert_eq!(
        handle.events.lock().unwrap().snapshots.len(),
        EVENT_CAPACITY - 1
    );
    let mut last = snapshot;
    loop {
        let code =
            unsafe { cosmos_surface_poll(pointer, bytes.as_mut_ptr(), bytes.len(), &mut required) };
        if code == EMPTY {
            break;
        }
        assert_eq!(code, OK);
        last = serde_json::from_slice(&bytes[..required]).unwrap();
    }
    assert_eq!(last["eventsSkipped"], 2);
    assert_eq!(required, 0);
    assert_eq!(handle.stop(), OK);
    assert_eq!(handle.enqueue(Command::Connect), CLOSED);
}

#[test]
fn destroy_joins_an_in_progress_callback_before_context_can_be_released() {
    let _exclusive = CLIENT_TEST.lock().unwrap_or_else(|e| e.into_inner());
    struct Gate {
        entered: sync_mpsc::Sender<()>,
        released: Mutex<bool>,
        changed: Condvar,
    }
    unsafe extern "C" fn gated_key(
        context: *mut c_void,
        _: *mut u8,
        _: usize,
        _: *mut usize,
    ) -> i32 {
        let gate = unsafe { &*(context.cast::<Gate>()) };
        let _ = gate.entered.send(());
        let released = gate.released.lock().unwrap_or_else(|e| e.into_inner());
        let _released = gate
            .changed
            .wait_while(released, |released| !*released)
            .unwrap_or_else(|e| e.into_inner());
        -1
    }
    struct OwnedHandle(*mut CosmosSurface);
    // SAFETY: The test transfers exclusive handle ownership to the destroyer.
    unsafe impl Send for OwnedHandle {}
    impl OwnedHandle {
        fn destroy(self) -> i32 {
            unsafe { cosmos_surface_destroy(self.0) }
        }
    }
    let (entered, arrival) = sync_mpsc::channel();
    let mut gate = Box::new(Gate {
        entered,
        released: Mutex::new(false),
        changed: Condvar::new(),
    });
    let functions = callbacks(gated_key, (&mut *gate as *mut Gate).cast());
    let config = public_config();
    let mut surface = ptr::null_mut();
    assert_eq!(
        unsafe { cosmos_surface_create(config.as_ptr(), config.len(), &functions, &mut surface) },
        OK
    );
    arrival.recv_timeout(Duration::from_secs(3)).unwrap();
    let owned = OwnedHandle(surface);
    let (started, starting) = sync_mpsc::channel();
    let (done, completion) = sync_mpsc::channel();
    let destroyer = thread::spawn(move || {
        started.send(()).unwrap();
        done.send(owned.destroy()).unwrap();
    });
    starting.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(completion.recv_timeout(Duration::from_millis(30)).is_err());
    *gate.released.lock().unwrap() = true;
    gate.changed.notify_all();
    assert_eq!(completion.recv_timeout(Duration::from_secs(3)).unwrap(), OK);
    destroyer.join().unwrap();
    drop(gate);
}

#[test]
fn callback_free_cleanup_holds_the_single_process_slot_without_blocking_destroy() {
    let _exclusive = CLIENT_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let permit = ClientPermit::acquire().expect("test must own the client slot");
    let (mut handle, _commands) = queued_handle();
    let (finished, completion) = sync_mpsc::channel();
    *handle.callbacks_finished.get_mut().unwrap() = Some(completion);
    let closed = handle.closed.clone();
    let (release, wait_for_release) = sync_mpsc::channel();
    let (released, release_observed) = sync_mpsc::channel();
    handle.worker = Some(thread::spawn(move || {
        let mut barrier = CallbackBarrier {
            completed: Some(finished),
            closed,
        };
        // Platform work is done; simulate an independently waiting SDK cleanup.
        barrier.finish(OK);
        wait_for_release.recv().unwrap();
        drop(permit);
        released.send(()).unwrap();
    }));
    let (destroyed, destruction) = sync_mpsc::channel();
    thread::spawn(move || {
        destroyed.send(handle.stop()).unwrap();
    });
    assert_eq!(
        destruction.recv_timeout(Duration::from_secs(3)).unwrap(),
        OK
    );
    let bytes = public_config();
    let functions = callbacks(missing, ptr::null_mut());
    let mut output = ptr::null_mut();
    assert_eq!(
        unsafe { cosmos_surface_create(bytes.as_ptr(), bytes.len(), &functions, &mut output) },
        QUEUE_FULL
    );
    assert!(output.is_null());
    release.send(()).unwrap();
    release_observed
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    let permit = ClientPermit::acquire().expect("completed cleanup must release the slot");
    drop(permit);
}
