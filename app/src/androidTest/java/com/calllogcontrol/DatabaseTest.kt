package com.calllogcontrol

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.calllogcontrol.Database.CallDatabase
import com.calllogcontrol.Database.CallRecord
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.StringWriter

@RunWith(AndroidJUnit4::class)
class DatabaseTest {
    @Test fun mergesPreserveAcknowledgementsAndRejectStaleSnapshots() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, CallDatabase::class.java).build()
        try {
            val dao = db.calls()
            val original = CallRecord("1-1000", "+595991", 2, 1000, 30, 1)
            dao.merge(listOf(original))
            dao.acknowledge(listOf(original))
            dao.merge(listOf(original))
            assertTrue(dao.pending().isEmpty())
            val changed = original.copy(durationSeconds = 45)
            dao.merge(listOf(changed))
            dao.acknowledge(listOf(original))
            assertEquals(listOf(changed), dao.pending())
            dao.acknowledge(listOf(changed))
            assertTrue(dao.pending().isEmpty())
            val csv = StringWriter()
            CsvExporter.write(dao, csv)
            assertTrue(csv.toString().contains("'+595991"))
            assertEquals(2, csv.toString().split("\r\n").count { it.isNotBlank() })
            dao.resetSync()
            assertEquals(1, dao.pending().size)
        } finally { db.close() }
    }
}
