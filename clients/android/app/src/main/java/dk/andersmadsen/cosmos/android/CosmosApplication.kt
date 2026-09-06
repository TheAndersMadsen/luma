package dk.andersmadsen.cosmos.android

import android.app.Application

class CosmosApplication : Application() {
    lateinit var controller: SurfaceController
        private set

    override fun onCreate() {
        super.onCreate()
        check(NativeSurface.initialize(this)) { "Cosmos native runtime failed to bind to this app" }
        controller = SurfaceController(this)
    }
}
