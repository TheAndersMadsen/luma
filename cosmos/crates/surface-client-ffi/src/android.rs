//! JNI binding for Android. Kotlin owns the Keystore key, the protected
//! journal, foreground state and rendering; the same worker as the C binding
//! owns admission, retries and RTC fencing. Snapshots cross as bytes.
use super::{
    Bindings, CLOSED, Command, CosmosSurface, INVALID_ARGUMENT, MAX_CONFIG, MAX_JOURNAL, MAX_TEXT,
    OK, config, spawn,
};
use cosmos_surface_client::{PlatformError, SecureStore, Signer};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JByteArray, JClass, JObject, JValue},
    sys::{jboolean, jbyteArray, jint, jlong},
};
use std::sync::Arc;

/// Calls into the Kotlin `NativeCallbacks` object from the worker thread.
/// The thread stays attached as a daemon; every call clears a pending Java
/// exception into a platform error instead of unwinding through JNI.
struct JavaPlatform {
    vm: JavaVM,
    callbacks: GlobalRef,
}

impl JavaPlatform {
    fn call_bytes(
        &self,
        name: &str,
        signature: &str,
        args: &[JValue],
        maximum: usize,
    ) -> Result<Option<Vec<u8>>, PlatformError> {
        let mut env = self
            .vm
            .attach_current_thread_as_daemon()
            .map_err(|_| PlatformError)?;
        let result = env.call_method(self.callbacks.as_obj(), name, signature, args);
        if env.exception_check().unwrap_or(true) {
            let _ = env.exception_clear();
            return Err(PlatformError);
        }
        let value = result
            .map_err(|_| PlatformError)?
            .l()
            .map_err(|_| PlatformError)?;
        if value.is_null() {
            return Ok(None);
        }
        let array = JByteArray::from(value);
        let length = env.get_array_length(&array).map_err(|_| PlatformError)?;
        if length < 0 || length as usize > maximum {
            return Err(PlatformError);
        }
        let bytes = env.convert_byte_array(&array).map_err(|_| PlatformError)?;
        Ok(Some(bytes))
    }
}

impl Signer for JavaPlatform {
    fn public_key_sec1(&self) -> Result<[u8; 65], PlatformError> {
        let bytes = self
            .call_bytes("publicKey", "()[B", &[], 65)?
            .ok_or(PlatformError)?;
        let key: [u8; 65] = bytes.try_into().map_err(|_| PlatformError)?;
        if key[0] != 4 {
            return Err(PlatformError);
        }
        Ok(key)
    }

    fn sign_sha256(&self, message: &[u8]) -> Result<Vec<u8>, PlatformError> {
        let env = self
            .vm
            .attach_current_thread_as_daemon()
            .map_err(|_| PlatformError)?;
        let input = env
            .byte_array_from_slice(message)
            .map_err(|_| PlatformError)?;
        let signature = self.call_bytes(
            "signSha256",
            "([B)[B",
            &[JValue::Object(&JObject::from(input))],
            72,
        )?;
        signature.filter(|der| !der.is_empty()).ok_or(PlatformError)
    }
}

impl SecureStore for JavaPlatform {
    fn load(&self) -> Result<Option<Vec<u8>>, PlatformError> {
        let journal = self.call_bytes("readJournal", "()[B", &[], MAX_JOURNAL)?;
        if journal.as_ref().is_some_and(Vec::is_empty) {
            return Err(PlatformError);
        }
        Ok(journal)
    }

    fn save_atomically(&self, journal: &[u8]) -> Result<(), PlatformError> {
        if journal.is_empty() || journal.len() > MAX_JOURNAL {
            return Err(PlatformError);
        }
        let mut env = self
            .vm
            .attach_current_thread_as_daemon()
            .map_err(|_| PlatformError)?;
        let input = env
            .byte_array_from_slice(journal)
            .map_err(|_| PlatformError)?;
        let result = env.call_method(
            self.callbacks.as_obj(),
            "writeJournalAtomically",
            "([B)Z",
            &[JValue::Object(&JObject::from(input))],
        );
        if env.exception_check().unwrap_or(true) {
            let _ = env.exception_clear();
            return Err(PlatformError);
        }
        match result.map_err(|_| PlatformError)?.z() {
            Ok(true) => Ok(()),
            _ => Err(PlatformError),
        }
    }
}

/// Status codes occupy a small negative range; any other value is a handle.
/// Android tags heap pointers in the top byte, so a handle may be negative.
fn is_status(handle: jlong) -> bool {
    (-16..=0).contains(&handle)
}

fn surface<'a>(handle: jlong) -> Option<&'a CosmosSurface> {
    if is_status(handle) {
        return None;
    }
    // SAFETY: Kotlin holds the handle returned by `create` until `destroy`,
    // and never calls another entry point concurrently with `destroy`.
    unsafe { (handle as usize as *const CosmosSurface).as_ref() }
}

fn enqueue(handle: jlong, command: Command) -> jint {
    surface(handle).map_or(INVALID_ARGUMENT, |surface| surface.enqueue(command))
}

/// Bind the SDK to this application once. Safe to repeat.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dk_andersmadsen_cosmos_android_NativeSurface_initialize(
    env: JNIEnv,
    _class: JClass,
    context: JObject,
) -> jboolean {
    let Ok(vm) = env.get_java_vm() else {
        return 0;
    };
    u8::from(cosmos_rtc::initialize_android(&vm, &context))
}

/// Returns an opaque nonzero handle, or a status code in -16..=-1 from the C
/// contract. Callers must test the status range, never the sign.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dk_andersmadsen_cosmos_android_NativeSurface_create(
    env: JNIEnv,
    _class: JClass,
    config_bytes: JByteArray,
    callbacks: JObject,
) -> jlong {
    let (Ok(vm), Ok(length)) = (env.get_java_vm(), env.get_array_length(&config_bytes)) else {
        return INVALID_ARGUMENT as jlong;
    };
    if callbacks.is_null() || length <= 0 || length as usize > MAX_CONFIG {
        return INVALID_ARGUMENT as jlong;
    }
    let Ok(bytes) = env.convert_byte_array(&config_bytes) else {
        return INVALID_ARGUMENT as jlong;
    };
    let Ok(callbacks) = env.new_global_ref(callbacks) else {
        return INVALID_ARGUMENT as jlong;
    };
    let config = match config(&bytes) {
        Ok(config) => config,
        Err(code) => return code as jlong,
    };
    let platform: Arc<dyn Bindings> = Arc::new(JavaPlatform { vm, callbacks });
    match spawn(config, platform) {
        Ok(handle) => Box::into_raw(handle) as usize as jlong,
        Err(code) => code as jlong,
    }
}

macro_rules! command {
    ($name:ident, $command:expr) => {
        #[unsafe(no_mangle)]
        pub extern "system" fn $name(_env: JNIEnv, _class: JClass, handle: jlong) -> jint {
            enqueue(handle, $command)
        }
    };
}
command!(
    Java_dk_andersmadsen_cosmos_android_NativeSurface_connect,
    Command::Connect
);
command!(
    Java_dk_andersmadsen_cosmos_android_NativeSurface_retryPending,
    Command::Retry
);
command!(
    Java_dk_andersmadsen_cosmos_android_NativeSurface_cancel,
    Command::Cancel
);
command!(
    Java_dk_andersmadsen_cosmos_android_NativeSurface_acknowledge,
    Command::Acknowledge
);
command!(
    Java_dk_andersmadsen_cosmos_android_NativeSurface_acknowledgeSpeech,
    Command::AcknowledgeSpeech
);
command!(
    Java_dk_andersmadsen_cosmos_android_NativeSurface_disconnect,
    Command::Disconnect
);

#[unsafe(no_mangle)]
pub extern "system" fn Java_dk_andersmadsen_cosmos_android_NativeSurface_setVisible(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    visible: jboolean,
) -> jint {
    enqueue(handle, Command::SetVisible(visible != 0))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dk_andersmadsen_cosmos_android_NativeSurface_sendText(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    text: JByteArray,
) -> jint {
    let Ok(length) = env.get_array_length(&text) else {
        return INVALID_ARGUMENT;
    };
    if length <= 0 || length as usize > MAX_TEXT {
        return INVALID_ARGUMENT;
    }
    let Ok(bytes) = env.convert_byte_array(&text) else {
        return INVALID_ARGUMENT;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return INVALID_ARGUMENT;
    };
    if text.trim().is_empty() {
        return INVALID_ARGUMENT;
    }
    enqueue(handle, Command::Text(text))
}

/// One complete snapshot, or null when the queue is empty or the handle is
/// invalid. The Kotlin side decodes it with the same rules as the C contract.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dk_andersmadsen_cosmos_android_NativeSurface_poll(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jbyteArray {
    let Some(surface) = surface(handle) else {
        return std::ptr::null_mut();
    };
    let Some(event) = surface.take_event() else {
        return std::ptr::null_mut();
    };
    env.byte_array_from_slice(&event)
        .map_or(std::ptr::null_mut(), |array| array.into_raw())
}

/// The current spoken reply's complete audio bytes, or null when none is
/// current. The snapshot names the reply; these are its exact bytes.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dk_andersmadsen_cosmos_android_NativeSurface_speechAudio(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jbyteArray {
    let Some(surface) = surface(handle) else {
        return std::ptr::null_mut();
    };
    let Some(audio) = surface.speech_audio() else {
        return std::ptr::null_mut();
    };
    env.byte_array_from_slice(&audio)
        .map_or(std::ptr::null_mut(), |array| array.into_raw())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dk_andersmadsen_cosmos_android_NativeSurface_destroy(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if is_status(handle) {
        return if handle == 0 { OK } else { CLOSED };
    }
    // SAFETY: Kotlin passes the handle from `create` exactly once and
    // performs no other call on it during or after this call.
    let mut surface = unsafe { Box::from_raw(handle as usize as *mut CosmosSurface) };
    surface.stop()
}
