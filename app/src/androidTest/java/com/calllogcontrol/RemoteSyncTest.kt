package com.calllogcontrol

import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.calllogcontrol.Database.CallDatabase
import com.calllogcontrol.Database.CallRecord
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RemoteSyncTest {
    @Test fun respondsWithActivityClosedAndScreenOff() {
        val args = InstrumentationRegistry.getArguments()
        val endpoint = args.getString("wifiEndpoint")
        val token = args.getString("wifiToken")
        val id = args.getString("wifiRecordId")
        assumeTrue("Requires a live test server and an external sync request", endpoint != null && token != null && id != null)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val security = SecurityStore(context)
        security.acceptCollection()
        security.saveCredentials(requireNotNull(endpoint), requireNotNull(token))
        assertTrue("Grant call-log permission on the dedicated emulator", CallImporter.permitted(context))
        val dao = CallDatabase.get(context).calls()
        runBlocking { dao.put(CallRecord(requireNotNull(id), "+595990000002", 2, System.currentTimeMillis(), 42, 1)) }
        phase("record ready")
        try {
            ActivityScenario.launch(MainActivity::class.java).use { activity ->
                phase("activity launched")
                activity.onActivity { it.startForegroundService(Intent(it, RemoteSyncService::class.java)) }
                phase("service requested")
                activity.moveToState(Lifecycle.State.CREATED)
                phase("activity closed")
                val deadline = System.currentTimeMillis() + 80_000
                while (System.currentTimeMillis() < deadline && runBlocking { dao.find(requireNotNull(id)) }?.synced != true) Thread.sleep(100)
                assertTrue("The remote request must upload while the activity is closed", runBlocking { dao.find(requireNotNull(id)) }?.synced == true)
                phase("record acknowledged")
                assertTrue(RemoteSyncService.running)
            }
        } finally {
            context.stopService(Intent(context, RemoteSyncService::class.java))
            security.disableSync()
            CallDatabase.get(context).openHelper.writableDatabase.execSQL("DELETE FROM calls WHERE id=?", arrayOf(requireNotNull(id)))
        }
    }

    private fun phase(value: String) {
        InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply { putString("stream", "\nREMOTE: $value\n") })
    }
}
