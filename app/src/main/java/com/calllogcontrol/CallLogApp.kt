package com.calllogcontrol

import android.app.Application

class CallLogApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (SecurityStore(this).consented) BackgroundWork.schedule(this)
    }
}
