package com.calllogcontrol.Database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [CallRecord::class], version = 1, exportSchema = true)
abstract class CallDatabase : RoomDatabase() {
    abstract fun calls(): CallDao

    companion object {
        @Volatile private var instance: CallDatabase? = null
        fun get(context: Context): CallDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, CallDatabase::class.java, "calls.db")
                .build().also { instance = it }
        }
    }
}
