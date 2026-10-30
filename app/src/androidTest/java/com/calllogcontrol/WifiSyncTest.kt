package com.calllogcontrol

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.calllogcontrol.Database.CallDatabase
import com.calllogcontrol.Database.CallRecord
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class WifiSyncTest {
    @Test fun sendsCallOverHttpsAndAcknowledgesOnlyAfterServerAccepts() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val endpoint = args.getString("wifiEndpoint")
        val token = args.getString("wifiToken")
        assumeTrue("Provide wifiEndpoint and wifiToken for this live integration test", endpoint != null && token != null)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dao = CallDatabase.get(context).calls()
        val id = args.getString("wifiRecordId") ?: "wifi-test-${UUID.randomUUID()}"
        val record = CallRecord(id, "+595990000001", 2, System.currentTimeMillis(), 87, 1)
        val security = SecurityStore(context)
        try {
            security.saveCredentials(requireNotNull(endpoint), requireNotNull(token))
            dao.put(record)
            val request = OneTimeWorkRequestBuilder<SyncWorker>().build()
            val work = WorkManager.getInstance(context)
            work.enqueue(request).result.get()
            val deadline = System.currentTimeMillis() + 60_000
            var state: WorkInfo.State? = null
            while (System.currentTimeMillis() < deadline) {
                state = work.getWorkInfoById(request.id).get()?.state
                if (state?.isFinished == true) break
                Thread.sleep(200)
            }
            val error = context.getSharedPreferences("status", Context.MODE_PRIVATE).getString("sync_error", "")
            assertEquals("HTTPS sync failed: $error", WorkInfo.State.SUCCEEDED, state)
            assertTrue("Server acknowledgement must mark the Room record as sent", dao.find(id)?.synced == true)
        } finally {
            security.disableSync()
            CallDatabase.get(context).openHelper.writableDatabase.execSQL("DELETE FROM calls WHERE id=?", arrayOf(id))
        }
    }
}
