fn main() {
    println!("cargo:rerun-if-env-changed=LK_CUSTOM_WEBRTC");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        webrtc_sys_build::configure_jni_symbols()
            .expect("Android builds must export the libwebrtc JNI natives from the shared library");
    }
}
