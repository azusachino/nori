import { databasePath } from './config'
import { openDatabase } from './database'

export const db = openDatabase(databasePath())
