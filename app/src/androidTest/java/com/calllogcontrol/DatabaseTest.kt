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
    @Test fun migratesExistingCallsWithoutChangingTheirSyncState() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "sim-migration-test.db"
        context.deleteDatabase(name)
        context.openOrCreateDatabase(name, 0, null).use { old ->
            old.execSQL("""CREATE TABLE calls (id TEXT NOT NULL PRIMARY KEY, number TEXT NOT NULL, type INTEGER NOT NULL,
                startedAt INTEGER NOT NULL, durationSeconds INTEGER NOT NULL, presentation INTEGER NOT NULL, synced INTEGER NOT NULL)""")
            old.execSQL("INSERT INTO calls VALUES ('old-1000','+595991',2,1000,30,1,1)")
            old.version = 1
        }
        val db = Room.databaseBuilder(context, CallDatabase::class.java, name).addMigrations(CallDatabase.MIGRATION_1_2).build()
        try {
            val record = requireNotNull(db.calls().find("old-1000"))
            assertTrue(record.synced)
            assertEquals("", record.phoneAccountId)
            assertEquals("", record.phoneAccountComponentName)
            assertEquals("", record.lineLabel)
            assertTrue(db.calls().pending().isEmpty())
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun simChangesRemainPendingAndMissingMetadataDoesNotEraseKnownLines() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val db = Room.inMemoryDatabaseBuilder(context, CallDatabase::class.java).build()
        try {
            val dao = db.calls()
            val first = CallRecord("1-1000", "+595991", 2, 1000, 30, 1,
                phoneAccountId = "account-1", phoneAccountComponentName = "com.android.phone/Telephony", lineLabel = "SIM 1")
            val second = first.copy(id = "2-1000", phoneAccountId = "account-2", lineLabel = "SIM 2")
            dao.merge(listOf(first, second))
            dao.acknowledge(listOf(first, second))
            val renamed = first.copy(lineLabel = "Ventas")
            dao.merge(listOf(renamed))
            dao.acknowledge(listOf(first))
            assertEquals(listOf(renamed), dao.pending())
            dao.acknowledge(listOf(renamed))
            dao.merge(listOf(renamed.copy(lineLabel = "")))
            dao.merge(listOf(renamed.copy(phoneAccountId = "", phoneAccountComponentName = "", lineLabel = "")))
            assertTrue(dao.pending().isEmpty())
            assertEquals("Ventas", dao.find(first.id)?.lineLabel)
            assertEquals("account-2", dao.find(second.id)?.phoneAccountId)
            val csv = StringWriter()
            CsvExporter.write(dao, csv)
            assertTrue(csv.toString().contains("sim_o_linea,cuenta_telefonica_id,cuenta_telefonica_componente"))
            assertTrue(csv.toString().contains("Ventas (account-1)"))
            assertTrue(csv.toString().contains("SIM 2 (account-2)"))
        } finally { db.close() }
    }

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
