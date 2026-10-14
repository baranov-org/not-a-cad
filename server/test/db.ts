import { migrate, pgliteDb, type Db } from "../src/db";

let template: Promise<Blob> | undefined;

// Fresh in-memory Postgres with the schema applied (cloned from a migrated dump: initdb is slow)
export async function testDb(): Promise<Db> {
  template ??= (async () => {
    const db = await pgliteDb();
    await migrate(db);
    const blob = await db.dump();
    await db.close();
    return blob;
  })();
  return pgliteDb(undefined, await template);
}
