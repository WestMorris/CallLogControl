package com.calllogcontrol.Database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [CallRecord::class], version = 2, exportSchema = true)
abstract class CallDatabase : RoomDatabase() {
    abstract fun calls(): CallDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE calls ADD COLUMN phoneAccountId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE calls ADD COLUMN phoneAccountComponentName TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE calls ADD COLUMN lineLabel TEXT NOT NULL DEFAULT ''")
            }
        }
        @Volatile private var instance: CallDatabase? = null
        fun get(context: Context): CallDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, CallDatabase::class.java, "calls.db")
                .addMigrations(MIGRATION_1_2)
                .build().also { instance = it }
        }
    }
}
