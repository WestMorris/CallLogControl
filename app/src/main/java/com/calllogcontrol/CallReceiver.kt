package com.calllogcontrol

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager

class CallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == TelephonyManager.ACTION_PHONE_STATE_CHANGED &&
            intent.getStringExtra(TelephonyManager.EXTRA_STATE) == TelephonyManager.EXTRA_STATE_IDLE &&
            SecurityStore(context).consented && CallImporter.permitted(context)) {
            // The provider can insert the finished call after the IDLE broadcast.
            BackgroundWork.collect(context, delaySeconds = 10)
        }
    }
}
