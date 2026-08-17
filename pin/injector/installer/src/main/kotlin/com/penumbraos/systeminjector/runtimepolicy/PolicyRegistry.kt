package com.penumbraos.systeminjector.runtimepolicy

import android.content.Context
import android.util.Log

object PolicyRegistry {
    private const val TAG = "RuntimePolicy"
    private const val PREFS_NAME = "runtimepolicy_registry"
    private const val KEY_TRACKED_PACKAGES = "tracked_packages"

    private fun storageContext(context: Context): Context {
        val deviceContext = context.createDeviceProtectedStorageContext()
        deviceContext.moveSharedPreferencesFrom(context, PREFS_NAME)
        return deviceContext
    }

    fun loadTrackedPackages(context: Context): Set<String> {
        return try {
            val prefs = storageContext(context).getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.getStringSet(KEY_TRACKED_PACKAGES, emptySet())?.toSet() ?: emptySet()
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to load tracked package registry", t)
            emptySet()
        }
    }

    fun addTrackedPackage(context: Context, packageName: String): Boolean {
        return try {
            val prefs = storageContext(context).getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val updated = prefs.getStringSet(KEY_TRACKED_PACKAGES, emptySet())?.toMutableSet() ?: mutableSetOf()
            val added = updated.add(packageName)
            if (!prefs.edit().putStringSet(KEY_TRACKED_PACKAGES, updated).commit()) {
                throw IllegalStateException("SharedPreferences commit failed while adding $packageName")
            }
            if (added) {
                Log.w(TAG, "Tracked package added: $packageName")
            } else {
                Log.w(TAG, "Tracked package already present: $packageName")
            }
            true
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to add tracked package $packageName", t)
            false
        }
    }

    fun removeTrackedPackage(context: Context, packageName: String): Boolean {
        return try {
            val prefs = storageContext(context).getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val updated = prefs.getStringSet(KEY_TRACKED_PACKAGES, emptySet())?.toMutableSet() ?: mutableSetOf()
            val removed = updated.remove(packageName)
            if (!removed) {
                Log.w(TAG, "Tracked package absent, nothing to remove: $packageName")
                return true
            }
            if (!prefs.edit().putStringSet(KEY_TRACKED_PACKAGES, updated).commit()) {
                throw IllegalStateException("SharedPreferences commit failed while removing $packageName")
            }
            Log.w(TAG, "Tracked package removed: $packageName")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to remove tracked package $packageName", t)
            false
        }
    }

    fun replaceTrackedPackages(context: Context, packageNames: Set<String>): Boolean {
        return try {
            val prefs = storageContext(context).getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (!prefs.edit().putStringSet(KEY_TRACKED_PACKAGES, packageNames.toSet()).commit()) {
                throw IllegalStateException("SharedPreferences commit failed while replacing tracked packages")
            }
            Log.w(TAG, "Tracked package registry replaced with ${packageNames.size} entries")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to replace tracked package registry", t)
            false
        }
    }
}
