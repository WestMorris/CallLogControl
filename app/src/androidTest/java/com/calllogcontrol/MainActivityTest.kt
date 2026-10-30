package com.calllogcontrol

import android.graphics.Bitmap
import android.graphics.Canvas
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.view.View
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.recyclerview.widget.RecyclerView
import com.calllogcontrol.Database.CallDatabase
import com.calllogcontrol.Database.CallRecord
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @Test fun createsPasswordShowsHistoryAndLocksOnBackground() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = context.getSharedPreferences("security", 0)
        prefs.edit().clear().commit()
        val dao = CallDatabase.get(context).calls()
        val record = CallRecord("ui-test-1000", "+595991123456", 2, 1793361600000, 87, 1)
        runBlocking { dao.put(record) }
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.confirmation).visibility)
                    capture(activity.window.decorView, "onboarding.png")
                    activity.findViewById<EditText>(R.id.password).setText("test-password-123")
                    activity.findViewById<EditText>(R.id.confirmation).setText("test-password-123")
                    activity.findViewById<Button>(R.id.unlock).performClick()
                }
                val deadline = System.currentTimeMillis() + 10_000
                var unlocked = false
                while (!unlocked && System.currentTimeMillis() < deadline) {
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                    scenario.onActivity {
                        val list = it.findViewById<RecyclerView>(R.id.calls)
                        unlocked = it.findViewById<View>(R.id.dashboard).visibility == View.VISIBLE &&
                            (list.adapter?.itemCount ?: 0) > 0 && list.childCount > 0
                    }
                    if (!unlocked) Thread.sleep(50)
                }
                assertTrue("Password creation must open the dashboard", unlocked)
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity { activity ->
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.loginPanel).visibility)
                    capture(activity.window.decorView, "dashboard.png")
                }
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                scenario.onActivity { activity ->
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.dashboard).visibility)
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.loginPanel).visibility)
                    assertEquals("", activity.findViewById<EditText>(R.id.password).text.toString())
                }
            }
        } finally {
            prefs.edit().clear().commit()
            CallDatabase.get(context).openHelper.writableDatabase.execSQL("DELETE FROM calls WHERE id=?", arrayOf(record.id))
        }
    }

    private fun capture(view: View, name: String) {
        if (Build.VERSION.SDK_INT < 29) return
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val resolver = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/CallLogControl")
        }
        val uri = requireNotNull(resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values))
        requireNotNull(resolver.openOutputStream(uri)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun credentialsAreEncryptedAndFailuresAreThrottled() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = context.getSharedPreferences("security", 0)
        prefs.edit().clear().commit()
        try {
            val security = SecurityStore(context)
            security.createPassword("test-password".toCharArray())
            assertTrue(security.verify("test-password".toCharArray()))
            repeat(5) { assertFalse(security.verify("wrong-password".toCharArray())) }
            assertTrue(security.cooldownSeconds > 0)
            assertFalse(security.verify("test-password".toCharArray()))
            val token = "device-" + "a".repeat(40)
            security.saveCredentials("https://example.com/", token)
            assertFalse(prefs.getString("token", "")!!.contains(token))
            assertEquals("https://example.com" to token, security.credentials())
            assertEquals(10, security.minimumTokenLength)
            security.saveCredentials("https://example.com/", "short-test")
            assertEquals("https://example.com" to "short-test", security.credentials())
            assertFalse(security.validToken("123456789"))
            assertFalse(security.validToken("123456789 k"))
            assertFalse(security.validToken("a".repeat(257)))
            val releaseContext = object : android.content.ContextWrapper(context) {
                override fun getApplicationInfo() = android.content.pm.ApplicationInfo(super.getApplicationInfo()).apply {
                    flags = flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE.inv()
                }
            }
            val releaseStore = SecurityStore(releaseContext)
            assertEquals(32, releaseStore.minimumTokenLength)
            assertFalse(releaseStore.validToken("short-test"))
            assertTrue(releaseStore.validToken(token))
            security.disableSync()
            assertNull(security.credentials())
        } finally { prefs.edit().clear().commit() }
    }
}
