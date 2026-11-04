package com.calllogcontrol

import android.Manifest
import android.content.ContentValues
import android.provider.CallLog
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.calllogcontrol.Database.CallDatabase
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CallImporterTest {
    @Test fun importsTheAccountOfEachCallIncludingUnavailableAccounts() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val resolver = context.contentResolver
        val prefs = context.getSharedPreferences("security", 0)
        val consented = SecurityStore(context).consented
        val calls = mutableListOf<Pair<android.net.Uri, String>>()
        instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.READ_CALL_LOG, Manifest.permission.WRITE_CALL_LOG)
        try {
            SecurityStore(context).acceptCollection()
            val started = System.currentTimeMillis()
            val component = "com.android.phone/com.android.services.telephony.TelephonyConnectionService"
            listOf("calllog-test-sim-1", "calllog-test-sim-2", "").forEachIndexed { index, account ->
                val date = started + index
                val values = ContentValues().apply {
                    put(CallLog.Calls.NUMBER, "+595990000001")
                    put(CallLog.Calls.TYPE, CallLog.Calls.OUTGOING_TYPE)
                    put(CallLog.Calls.DATE, date)
                    put(CallLog.Calls.DURATION, 30)
                    put(CallLog.Calls.NUMBER_PRESENTATION, CallLog.Calls.PRESENTATION_ALLOWED)
                    put(CallLog.Calls.PHONE_ACCOUNT_ID, account)
                    put(CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME, if (account.isEmpty()) "" else component)
                }
                val uri = requireNotNull(resolver.insert(CallLog.Calls.CONTENT_URI, values))
                calls.add(uri to "${uri.lastPathSegment}-$date")
            }
            CallImporter.import(context)
            val dao = CallDatabase.get(context).calls()
            assertEquals("calllog-test-sim-1", dao.find(calls[0].second)?.phoneAccountId)
            assertEquals("calllog-test-sim-2", dao.find(calls[1].second)?.phoneAccountId)
            assertEquals(component, dao.find(calls[1].second)?.phoneAccountComponentName)
            assertEquals("", dao.find(calls[1].second)?.lineLabel)
            assertEquals("No disponible", callLine(requireNotNull(dao.find(calls[2].second))))
        } finally {
            calls.forEach { (uri, id) ->
                resolver.delete(CallLog.Calls.CONTENT_URI, "${CallLog.Calls._ID}=?", arrayOf(requireNotNull(uri.lastPathSegment)))
                CallDatabase.get(context).openHelper.writableDatabase.execSQL("DELETE FROM calls WHERE id=?", arrayOf(id))
            }
            prefs.edit().putBoolean("consented", consented).commit()
            instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }
}
