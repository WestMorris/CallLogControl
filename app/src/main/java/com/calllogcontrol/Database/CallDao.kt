package com.calllogcontrol.Database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

data class CallStats(val total: Int, val pending: Int)

@Dao
abstract class CallDao {
    @Query("SELECT * FROM calls ORDER BY startedAt DESC LIMIT 200")
    abstract fun latest(): Flow<List<CallRecord>>

    @Query("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN synced=0 THEN 1 ELSE 0 END),0) AS pending FROM calls")
    abstract fun stats(): Flow<CallStats>

    @Query("SELECT * FROM calls WHERE id=:id")
    abstract suspend fun find(id: String): CallRecord?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun put(record: CallRecord)

    @Transaction
    open suspend fun merge(records: List<CallRecord>) {
        records.forEach { record ->
            val previous = find(record.id)
            val current = when {
                previous == null -> record
                record.phoneAccountId.isEmpty() && record.phoneAccountComponentName.isEmpty() -> record.copy(
                    phoneAccountId = previous.phoneAccountId, phoneAccountComponentName = previous.phoneAccountComponentName,
                    lineLabel = previous.lineLabel)
                record.phoneAccountId == previous.phoneAccountId && record.phoneAccountComponentName == previous.phoneAccountComponentName &&
                    record.lineLabel.isEmpty() -> record.copy(lineLabel = previous.lineLabel)
                else -> record
            }
            if (previous == null || previous.copy(synced = false) != current) put(current)
        }
    }

    @Query("SELECT * FROM calls WHERE synced=0 ORDER BY startedAt,id LIMIT 100")
    abstract suspend fun pending(): List<CallRecord>

    @Query("""UPDATE calls SET synced=1 WHERE id=:id AND number=:number AND type=:type
        AND durationSeconds=:duration AND presentation=:presentation
        AND phoneAccountId=:phoneAccountId AND phoneAccountComponentName=:phoneAccountComponentName AND lineLabel=:lineLabel""")
    abstract suspend fun acknowledge(id: String, number: String, type: Int, duration: Long, presentation: Int,
        phoneAccountId: String, phoneAccountComponentName: String, lineLabel: String)

    @Transaction
    open suspend fun acknowledge(records: List<CallRecord>) {
        records.forEach { acknowledge(it.id, it.number, it.type, it.durationSeconds, it.presentation,
            it.phoneAccountId, it.phoneAccountComponentName, it.lineLabel) }
    }

    @Query("UPDATE calls SET synced=0")
    abstract suspend fun resetSync()

    @Query("SELECT rowid, * FROM calls WHERE rowid > :after ORDER BY rowid LIMIT 500")
    abstract suspend fun exportPage(after: Long): List<ExportRow>
}

data class ExportRow(
    @androidx.room.ColumnInfo(name = "rowid") val rowId: Long,
    @androidx.room.Embedded val record: CallRecord,
)
