package com.calllogcontrol.Database

import androidx.room.Entity
import androidx.room.ColumnInfo
import androidx.room.PrimaryKey

@Entity(tableName = "calls")
data class CallRecord(
    @PrimaryKey val id: String,
    val number: String,
    val type: Int,
    val startedAt: Long,
    val durationSeconds: Long,
    val presentation: Int,
    val synced: Boolean = false,
    @ColumnInfo(defaultValue = "''") val phoneAccountId: String = "",
    @ColumnInfo(defaultValue = "''") val phoneAccountComponentName: String = "",
    @ColumnInfo(defaultValue = "''") val lineLabel: String = "",
)
