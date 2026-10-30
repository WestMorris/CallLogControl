package com.calllogcontrol.Database

import androidx.room.Entity
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
)
