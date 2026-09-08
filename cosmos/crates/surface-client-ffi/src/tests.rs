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
fn snapshots_project_choice_cards_and_turn_status_without_surface_identity() {
    use cosmos_surface_client::{ChoiceItem, DisplayContent, Privacy, SurfacePlatform, TurnState};
    let card = Display {
        action_id: Uuid::from_u128(7),
        turn_id: Uuid::from_u128(8),
        generation: 2,
        content_digest: "ab".repeat(32),
        content: DisplayContent::Choices {
            title: "Films for tonight".into(),
            items: vec![
                ChoiceItem {
                    id: "1".into(),
                    title: "Arrival".into(),
                    detail: "2016".into(),
                },
                ChoiceItem {
                    id: "2".into(),
                    title: "Heat".into(),
                    detail: String::new(),
                },
            ],
        },
        expires_at_ms: 60_000,
        privacy: Privacy::SharedRoom,
    };
    assert_eq!(
        display(Some(&card)),
        json!({
            "actionId": Uuid::from_u128(7).to_string(),
            "turnId": Uuid::from_u128(8).to_string(),
            "generation": 2,
            "contentDigest": "ab".repeat(32),
            "expiresAtMs": 60_000,
            "content": {"kind": "choices", "title": "Films for tonight", "items": [
                {"id": "1", "title": "Arrival", "detail": "2016"},
                {"id": "2", "title": "Heat", "detail": ""},
            ]},
            "credits": [],
            "privacy": "shared_room",
        })
    );
    let turn = TurnStatus {
        turn_id: Uuid::from_u128(8),
        generation: 2,
        state: TurnState::Shown,
        surface: Some(SurfacePlatform::AndroidTv),
        privacy: Privacy::Public,
    };
    assert_eq!(
        status(Some(&turn)),
        json!({
            "turnId": Uuid::from_u128(8).to_string(),
            "generation": 2,
            "state": "shown",
            "surfacePlatform": "android_tv",
            "privacy": "public",
        })
    );
    let working = TurnStatus {
        state: TurnState::Working,
        surface: None,
        ..turn
    };
    assert_eq!(status(Some(&working))["state"], "working");
    assert!(status(Some(&working))["surfacePlatform"].is_null());
    assert!(status(None).is_null());
    let empty = snapshot(None, &Value::Null, "status", None);
    assert!(empty["status"].is_null());
    assert_eq!(empty["operation"], "status");
}

/// The snapshot names the bound command and the ceremony a platform must
/// render, and nothing about which surface Cosmos chose.
#[test]
fn ffi_snapshot_reports_task_and_confirmation() {
    use cosmos_surface_client::{
        Attestation, Confirmation, Description, Locator, Operation, Privacy, Risk, Task,
    };
    let operation = Operation::Open {
        locator: Locator::Https {
            url: "https://github.com/owner/repo/pull/412".into(),
        },
        version: None,
        position: None,
        label: "PR 412".into(),
    };
    let bound = Task {
        action_id: Uuid::from_u128(7),
        turn_id: Uuid::from_u128(8),
        generation: 2,
        channel: "action.open".into(),
        content_digest: operation.content_digest(),
        idempotency_key: "a0".to_owned() + &"4".repeat(62),
        operation: operation.clone(),
        expires_at_ms: 60_000,
        report_by_ms: 30_000,
        privacy: Privacy::SharedRoom,
    };
    let projected = task(Some(&bound));
    assert_eq!(projected["actionId"], Uuid::from_u128(7).to_string());
    assert_eq!(projected["channel"], "action.open");
    assert_eq!(projected["contentDigest"], operation.content_digest());
    assert_eq!(projected["reportByMs"], 30_000);
    assert_eq!(projected["operation"]["kind"], "open");
    assert_eq!(projected["operation"]["locator"]["scheme"], "https");
    assert!(task(None).is_null());

    let description = Description {
        kind: cosmos_surface_client::action::DescriptionKind::DeviceAction,
        verb: "run".into(),
        subject: "Project tests".into(),
        device_kind: "macos".into(),
        effect: "changes files on that device".into(),
        class: Privacy::Private,
    };
    let ceremony = Confirmation {
        grant_id: Uuid::from_u128(11),
        action_id: Uuid::from_u128(7),
        turn_id: Uuid::from_u128(8),
        generation: 2,
        description_digest: description.content_digest(),
        description,
        risk: Risk::High,
        attestation: Attestation::DeviceOwnerAuth,
        privacy: Privacy::Private,
        expires_at_ms: 30_000,
    };
    let projected = confirmation(Some(&ceremony));
    assert_eq!(projected["grantId"], Uuid::from_u128(11).to_string());
    assert_eq!(projected["risk"], "high");
    assert_eq!(projected["attestation"], "device_owner_auth");
    assert_eq!(projected["description"]["verb"], "run");
    assert_eq!(projected["description"]["subject"], "Project tests");
    assert_eq!(
        projected["descriptionDigest"],
        ceremony.description.content_digest()
    );
    assert!(confirmation(None).is_null());
    let empty = snapshot(None, &Value::Null, "task", None);
    assert!(empty["task"].is_null() && empty["confirmation"].is_null());
}

/// A report crosses the boundary as bounded JSON and is refused before it can
/// queue anything when it claims what its evidence does not show; a grant
/// without the attestation the ceremony asked for is not an answer.
#[test]
fn ffi_report_and_grant_arguments_are_checked_before_queueing() {
    let (handle, mut commands) = queued_handle();
    let surface = Box::into_raw(handle);
    let action = Uuid::from_u128(7).to_string();
    let call = |body: &str| unsafe {
        cosmos_surface_report(
            surface,
            action.as_ptr(),
            action.len(),
            body.as_ptr(),
            body.len(),
        )
    };
    let opened = r#"{"outcome":"completed","evidence":{"kind":"open","opened":true}}"#;
    assert_eq!(call("not json"), INVALID_ARGUMENT);
    assert_eq!(
        call(r#"{"outcome":"completed","evidence":{"kind":"open","opened":true},"extra":1}"#),
        INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe {
            cosmos_surface_report(surface, action.as_ptr(), action.len(), std::ptr::null(), 0)
        },
        INVALID_ARGUMENT
    );
    // A report must name the action it is about, and name it exactly.
    for named in ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000"] {
        assert_eq!(
            unsafe {
                cosmos_surface_report(
                    surface,
                    named.as_ptr(),
                    named.len(),
                    opened.as_ptr(),
                    opened.len(),
                )
            },
            INVALID_ARGUMENT,
            "accepted a report for {named:?}"
        );
    }
    assert_eq!(call(opened), OK);
    assert!(matches!(
        commands.try_recv(),
        Ok(Command::Report { action_id, .. }) if action_id == Uuid::from_u128(7)
    ));

    let attestation = b"device_owner_auth";
    assert_eq!(
        unsafe { cosmos_surface_grant(surface, 1, attestation.as_ptr(), attestation.len()) },
        OK
    );
    assert!(matches!(
        commands.try_recv(),
        Ok(Command::Grant {
            granted: true,
            attestation: Some(cosmos_surface_client::Attestation::DeviceOwnerAuth),
        })
    ));
    // Granting with no actor evidence at all is not an answer.
    assert_eq!(
        unsafe { cosmos_surface_grant(surface, 1, std::ptr::null(), 0) },
        INVALID_ARGUMENT
    );
    // Declining needs none, and weighs exactly as much.
    assert_eq!(
        unsafe { cosmos_surface_grant(surface, 0, std::ptr::null(), 0) },
        OK
    );
    assert!(matches!(
        commands.try_recv(),
        Ok(Command::Grant {
            granted: false,
            attestation: None,
        })
    ));
    let unknown = b"trust_me";
    assert_eq!(
        unsafe { cosmos_surface_grant(surface, 1, unknown.as_ptr(), unknown.len()) },
        INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { cosmos_surface_grant(surface, 2, std::ptr::null(), 0) },
        INVALID_ARGUMENT
    );
    assert_eq!(unsafe { cosmos_surface_progress(surface, 3, 41_200) }, OK);
    assert!(matches!(
        commands.try_recv(),
        Ok(Command::Progress {
            sequence: 3,
            elapsed_ms: 41_200,
        })
    ));
    drop(unsafe { Box::from_raw(surface) });
}

#[test]
fn bound_text_target_and_context_arguments_are_checked_before_queueing() {
    assert_eq!(parse_target(None), Ok(None));
    assert_eq!(parse_target(Some(b"")), Ok(None));
    assert_eq!(
        parse_target(Some(b"android_tv")),
        Ok(Some(Platform::AndroidTv))
    );
    assert_eq!(parse_target(Some(b"macos")), Ok(Some(Platform::Macos)));
    for invalid in [
        &b"browser"[..],
        b"pin",
        b"ANDROID",
        b"android_tv\0",
        b"\xff",
    ] {
        assert_eq!(parse_target(Some(invalid)), Err(INVALID_ARGUMENT));
    }
    assert_eq!(parse_text(b"hello").as_deref(), Ok("hello"));
    for invalid in [&b""[..], b" \n", b"\xff", &vec![b'x'; MAX_TEXT + 1]] {
        assert_eq!(parse_text(invalid), Err(INVALID_ARGUMENT));
    }
    let context = parse_context(b"Settings", b"Wi-Fi\nConnected").unwrap();
    assert_eq!(
        (context.app.as_str(), context.text.as_str()),
        ("Settings", "Wi-Fi\nConnected")
    );
    for (app, text) in [
        (&b""[..], &b"x"[..]),
        (b" ", b"x"),
        (b"App", b""),
        (b"App", b" "),
        (b"\xff", b"x"),
        (b"App", b"\xff"),
        (&vec![b'a'; MAX_CONTEXT_APP + 1][..], b"x"),
        (b"App", &vec![b'x'; MAX_CONTEXT + 1][..]),
    ] {
        assert_eq!(parse_context(app, text).map(|_| ()), Err(INVALID_ARGUMENT));
    }
    let (mut handle, _receiver) = queued_handle();
    let pointer = (&mut *handle) as *mut CosmosSurface;
    let text = b"Play trailer for number two";
    assert_eq!(
        unsafe { cosmos_surface_send_text_to(pointer, text.as_ptr(), text.len(), ptr::null(), 0) },
        OK
    );
    assert_eq!(
        unsafe {
            cosmos_surface_send_text_to(
                pointer,
                text.as_ptr(),
                text.len(),
                b"android_tv".as_ptr(),
                10,
            )
        },
        OK
    );
    assert_eq!(
        unsafe {
            cosmos_surface_send_text_to(pointer, text.as_ptr(), text.len(), b"browser".as_ptr(), 7)
        },
        INVALID_ARGUMENT
    );
    let app = b"Settings";
    let context = b"Wi-Fi";
    assert_eq!(
        unsafe {
            cosmos_surface_send_text_with_context(
                pointer,
                text.as_ptr(),
                text.len(),
                app.as_ptr(),
                app.len(),
                context.as_ptr(),
                context.len(),
                ptr::null(),
                0,
            )
        },
        OK
    );
    assert_eq!(
        unsafe {
            cosmos_surface_send_text_with_context(
                pointer,
                text.as_ptr(),
                text.len(),
                ptr::null(),
                0,
                context.as_ptr(),
                context.len(),
                ptr::null(),
                0,
            )
        },
        INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe {
            cosmos_surface_send_text_with_context(
                pointer,
                text.as_ptr(),
                text.len(),
                app.as_ptr(),
                app.len(),
                context.as_ptr(),
                context.len(),
                b"pin".as_ptr(),
                3,
            )
        },
        INVALID_ARGUMENT
    );
}

#[test]
fn document_arguments_are_preserved_or_rejected_before_queueing() {
    let (mut handle, mut receiver) = queued_handle();
    let pointer = (&mut *handle) as *mut CosmosSurface;
    let send = |document: *const u8, length| unsafe {
        cosmos_surface_send_text_with_document(
            pointer,
            b"Explain this".as_ptr(),
            12,
            b"Preview".as_ptr(),
            7,
            b"Paragraph".as_ptr(),
            9,
            document,
            length,
            b"linux".as_ptr(),
            5,
        )
    };
    assert_eq!(send(ptr::null(), 1), INVALID_ARGUMENT);
    assert!(receiver.try_recv().is_err());
    for invalid in [
        b"{".to_vec(),
        b"null".to_vec(),
        b"[]".to_vec(),
        b"\"document\"".to_vec(),
        b"\xff".to_vec(),
        vec![b'x'; MAX_DOCUMENT + 1],
    ] {
        assert_eq!(send(invalid.as_ptr(), invalid.len()), INVALID_ARGUMENT);
        assert!(receiver.try_recv().is_err());
    }
    let document =
        br#"{"app":"Preview","locator":{"scheme":"https","url":"https://example.test/agenda"},"label":"Agenda"}"#;
    for (bytes, length, expected) in [
        (
            document.as_ptr(),
            document.len(),
            Some(std::str::from_utf8(document).unwrap()),
        ),
        (ptr::null(), 0, None),
    ] {
        assert_eq!(send(bytes, length), OK);
        let Command::TextWithContext {
            text,
            context,
            target,
        } = receiver.try_recv().unwrap()
        else {
            panic!("wrong command")
        };
        assert_eq!(text, "Explain this");
        assert_eq!(context.app, "Preview");
        assert_eq!(context.text, "Paragraph");
        assert_eq!(context.document.as_deref(), expected);
        assert_eq!(target, Some(Platform::Linux));
        assert!(receiver.try_recv().is_err());
    }
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
            policy_document: Arc::new(Mutex::new(None)),
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
