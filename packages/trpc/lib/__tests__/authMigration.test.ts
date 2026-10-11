import {
  mkdtempSync,
  readFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";

const migrationsFolder = path.resolve(
  import.meta.dirname,
  "../../../db/drizzle",
);
const journal = JSON.parse(
  readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
);

test("Better Auth applies after fork migrations and preserves retained media, sets and local batches", () => {
  const prefix = mkdtempSync(path.join(tmpdir(), "karakeep-migration-"));
  const sqlite = new Database(":memory:");
  try {
    mkdirSync(path.join(prefix, "meta"));
    const previous = journal.entries.filter(
      (entry: { idx: number }) => entry.idx <= 104,
    );
    writeFileSync(
      path.join(prefix, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: previous }),
    );
    for (const entry of previous)
      cpSync(
        path.join(migrationsFolder, `${entry.tag}.sql`),
        path.join(prefix, `${entry.tag}.sql`),
      );
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: prefix });
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      INSERT INTO user (id,name,email,password,salt,emailVerified) VALUES ('owner','Owner','OWNER@example.test','old-hash','old-salt',1700000000);
      INSERT INTO account (userId,type,provider,providerAccountId,access_token,expires_at) VALUES ('owner','oauth','github','github-id','test-token',1700000000);
      INSERT INTO session (sessionToken,userId,expires) VALUES ('old-session','owner',1900000000);
      INSERT INTO bookmarks (id,createdAt,lastSavedAt,userId,type,title,titleSource,mediaAi,sensitiveCategories,processingPolicy) VALUES ('photo',1700000000,1700000000,'owner','asset','Manual title','manual','{"status":"success"}','["sexual"]','deferred');
      INSERT INTO assets (id,assetType,size,contentType,width,height,bookmarkId,userId) VALUES ('original','bookmarkAsset',1234,'image/jpeg',96,64,'photo','owner');
      INSERT INTO bookmarks (id,createdAt,lastSavedAt,userId,type) VALUES ('set',1700000000,1700000000,'owner','text');
      INSERT INTO imageSets (bookmarkId,coverBookmarkId) VALUES ('set','photo');
      INSERT INTO imageSetMembers (setId,bookmarkId,assetId,position) VALUES ('set','photo','original',0);
      INSERT INTO importSourceObjects (id,userId,provider,accountScope,objectId) VALUES ('source','owner','nextcloud','fixture','photo');
      INSERT INTO importSourceRevisions (id,sourceObjectId,userId,revision,payloadDigest,payload,state,fencingToken,leaseUntil,bookmarkId,createdAt) VALUES ('revision','source','owner','1','digest','{}','committed',1,0,'photo',1700000000);
      INSERT INTO importLocalCheckBatches (id,userId,selectionKey,status,createdAt) VALUES ('batch','owner','fixture','paused',1700000000);
      INSERT INTO importLocalCheckItems (batchId,bookmarkId,sourceRevisionId,requestId,generation,policyRevision,contentRevision,state) VALUES ('batch','photo','revision','request',1,1,1,'pending');
    `);
    const protectedTables = [
      "bookmarks",
      "assets",
      "imageSets",
      "imageSetMembers",
      "importSourceObjects",
      "importSourceRevisions",
      "importLocalCheckBatches",
      "importLocalCheckItems",
    ];
    const before = protectedTables.map((table) =>
      sqlite.prepare(`SELECT * FROM ${table}`).all(),
    );
    migrate(db, { migrationsFolder });
    expect(
      protectedTables.map((table) =>
        sqlite.prepare(`SELECT * FROM ${table}`).all(),
      ),
    ).toEqual(before);
    expect(
      sqlite.prepare("SELECT email,emailVerified FROM user").get(),
    ).toEqual({ email: "owner@example.test", emailVerified: 1 });
    expect(
      sqlite
        .prepare("SELECT password FROM account WHERE providerId='credential'")
        .get(),
    ).toEqual({ password: "bcrypt-salted:old-salt:old-hash" });
    expect(
      sqlite
        .prepare(
          "SELECT accountId,accessToken,accessTokenExpiresAt FROM account WHERE providerId='github'",
        )
        .get(),
    ).toEqual({
      accountId: "github-id",
      accessToken: "test-token",
      accessTokenExpiresAt: 1700000000000,
    });
    expect(sqlite.prepare("SELECT * FROM session").all()).toEqual([]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(
      sqlite.prepare("SELECT * FROM __drizzle_migrations").all(),
    ).toHaveLength(journal.entries.length);
    // A second startup must not replay either history or the auth conversion.
    migrate(db, { migrationsFolder });
    expect(sqlite.prepare("SELECT * FROM account").all()).toHaveLength(2);
    expect(
      protectedTables.map((table) =>
        sqlite.prepare(`SELECT * FROM ${table}`).all(),
      ),
    ).toEqual(before);
  } finally {
    sqlite.close();
    rmSync(prefix, { recursive: true, force: true });
  }
});
