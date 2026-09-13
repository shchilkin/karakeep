import type { SensitiveCategory } from "@karakeep/shared/sensitiveContent";
import type { AdapterAccount } from "@auth/core/adapters";
import { createId } from "@paralleldrive/cuid2";
import { relations, sql, SQL } from "drizzle-orm";
import {
  AnySQLiteColumn,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import type { MediaCatalogState } from "@karakeep/shared/mediaCatalog";
import type { AiBatchEntry, AiBatchRequest } from "@karakeep/shared/aiControl";

import type { ZApiKeyScope } from "@karakeep/shared/types/apiKeys";
import { API_KEY_FULL_ACCESS_SCOPE } from "@karakeep/shared/types/apiKeys";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { ZReaderViewReason } from "@karakeep/shared/types/bookmarks";

function createdAtField(colName = "createdAt") {
  return integer(colName, { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());
}

function createdAtMsField() {
  return integer("createdAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
}

function modifiedAtField() {
  return integer("modifiedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());
}

function modifiedAtMsField() {
  return integer("modifiedAt", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());
}

export const users = sqliteTable("user", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
  image: text("image"),
  password: text("password"),
  salt: text("salt").notNull().default(""),
  role: text("role", { enum: ["admin", "user"] }).default("user"),

  // Admin Only Settings
  bookmarkQuota: integer("bookmarkQuota"),
  storageQuota: integer("storageQuota"),
  browserCrawlingEnabled: integer("browserCrawlingEnabled", {
    mode: "boolean",
  }),
  // Admin-granted plan label (e.g. a collaborator name). While set, Stripe
  // sync doesn't downgrade the user's entitlements; it's cleared when the
  // user gets an active Stripe subscription.
  manualTierName: text("manualTierName"),

  // User Settings
  bookmarkClickAction: text("bookmarkClickAction", {
    enum: ["open_original_link", "expand_bookmark_preview"],
  })
    .notNull()
    .default("open_original_link"),
  archiveDisplayBehaviour: text("archiveDisplayBehaviour", {
    enum: ["show", "hide"],
  })
    .notNull()
    .default("show"),
  timezone: text("timezone").default("UTC"),

  // Backup Settings
  backupsEnabled: integer("backupsEnabled", { mode: "boolean" })
    .notNull()
    .default(false),
  backupsFrequency: text("backupsFrequency", {
    enum: ["daily", "weekly"],
  })
    .notNull()
    .default("weekly"),
  backupsRetentionDays: integer("backupsRetentionDays").notNull().default(30),

  // Reader view settings (nullable = opt-in, null means use client default)
  readerFontSize: integer("readerFontSize"),
  readerLineHeight: real("readerLineHeight"),
  readerFontFamily: text("readerFontFamily", {
    enum: ["serif", "sans", "mono"],
  }),

  // AI Settings (nullable = opt-in, null means use server default)
  autoTaggingEnabled: integer("autoTaggingEnabled", { mode: "boolean" }),
  autoSummarizationEnabled: integer("autoSummarizationEnabled", {
    mode: "boolean",
  }),
  tagStyle: text("tagStyle", {
    enum: [
      "lowercase-hyphens",
      "lowercase-spaces",
      "lowercase-underscores",
      "titlecase-spaces",
      "titlecase-hyphens",
      "camelCase",
      "as-generated",
    ],
  }).default("titlecase-spaces"),
  curatedTagIds: text("curatedTagIds", { mode: "json" }).$type<string[]>(),
  inferredTagLang: text("inferredTagLang"),
});

export const accounts = sqliteTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccount["type"]>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  ],
);

export const sessions = sqliteTable("session", {
  sessionToken: text("sessionToken")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
});

export const verificationTokens = sqliteTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

export const passwordResetTokens = sqliteTable(
  "passwordResetToken",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAtField(),
  },
  (prt) => [index("passwordResetTokens_userId_idx").on(prt.userId)],
);

export const apiKeys = sqliteTable(
  "apiKey",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    createdAt: createdAtField(),
    lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
    keyId: text("keyId").notNull().unique(),
    keyHash: text("keyHash").notNull(),
    scopes: text("scopes", { mode: "json" })
      .$type<ZApiKeyScope[]>()
      .notNull()
      .$defaultFn(() => [API_KEY_FULL_ACCESS_SCOPE]),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (ak) => [unique().on(ak.name, ak.userId)],
);

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    // The `createdAt` field and the `createdAt` column intentionally don't
    // match. Re-saving an existing bookmark bumps it back to the top of the
    // list, so the timestamp everything sorts and filters on is now "when was
    // this last saved" and lives in the `lastSavedAt` column. It keeps the
    // `createdAt` field name because that's what the API has always exposed and
    // what every query already orders by. The immutable "when did this row
    // first appear" timestamp stays in the original `createdAt` column, and is
    // exposed to clients as `firstCreatedAt`.
    dbCreatedAt: createdAtField(),
    createdAt: createdAtField("lastSavedAt"),
    modifiedAt: modifiedAtField(),
    title: text("title"),
    titleSource: text("titleSource", {
      enum: ["manual", "captured", "unknown"],
    })
      .notNull()
      .default("unknown"),
    sensitiveCategories: text("sensitiveCategories", { mode: "json" }).$type<
      SensitiveCategory[]
    >(),
    mediaAi: text("mediaAi", { mode: "json" }).$type<MediaCatalogState>(),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    favourited: integer("favourited", { mode: "boolean" })
      .notNull()
      .default(false),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    processingPolicy: text("processingPolicy", {
      enum: ["automatic", "deferred"],
    })
      .notNull()
      .default("automatic"),
    policyRevision: integer("policyRevision").notNull().default(1),
    contentRevision: integer("contentRevision").notNull().default(1),
    taggingStatus: text("taggingStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    summarizationStatus: text("summarizationStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    embeddingStatus: text("embeddingStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    summary: text("summary"),
    note: text("note"),
    type: text("type", {
      enum: [BookmarkTypes.LINK, BookmarkTypes.TEXT, BookmarkTypes.ASSET],
    }).notNull(),
    source: text("source", {
      enum: [
        "api",
        "web",
        "extension",
        "cli",
        "mobile",
        "singlefile",
        "rss",
        "import",
      ],
    }),
  },
  (b) => [
    index("bookmarks_lastSavedAt_idx").on(b.createdAt),
    // Composite indexes for optimized pagination queries
    index("bookmarks_userId_lastSavedAt_id_idx").on(
      b.userId,
      b.createdAt,
      b.id,
    ),
    index("bookmarks_userId_archived_lastSavedAt_id_idx").on(
      b.userId,
      b.archived,
      b.createdAt,
      b.id,
    ),
    index("bookmarks_userId_favourited_lastSavedAt_id_idx").on(
      b.userId,
      b.favourited,
      b.createdAt,
      b.id,
    ),
  ],
);

export const bookmarkLinks = sqliteTable(
  "bookmarkLinks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId())
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    url: text("url").notNull(),

    // Crawled info
    title: text("title"),
    description: text("description"),
    author: text("author"),
    publisher: text("publisher"),
    datePublished: integer("datePublished", { mode: "timestamp" }),
    dateModified: integer("dateModified", { mode: "timestamp" }),
    imageUrl: text("imageUrl"),
    favicon: text("favicon"),
    htmlContent: text("htmlContent"),
    contentAssetId: text("contentAssetId"),
    readerViewStatus: text("readerViewStatus", {
      enum: ["readable", "not_readable", "uncertain", "unavailable"],
    }),
    readerViewScore: integer("readerViewScore"),
    readerViewReasons: text("readerViewReasons", { mode: "json" }).$type<
      ZReaderViewReason[]
    >(),
    readerViewClassifierVersion: integer("readerViewClassifierVersion"),
    crawledAt: integer("crawledAt", { mode: "timestamp" }),
    crawlStatus: text("crawlStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    crawlStatusCode: integer("crawlStatusCode").default(200),
    // When the pre-crawl probe last extracted and stored this link's metadata.
    // Lets crawl retries skip re-fetching it.
    probeMetadataAt: integer("probeMetadataAt", { mode: "timestamp" }),
  },
  (bl) => [index("bookmarkLinks_url_idx").on(bl.url)],
);

export const enum AssetTypes {
  LINK_BANNER_IMAGE = "linkBannerImage",
  LINK_SCREENSHOT = "linkScreenshot",
  LINK_PDF = "linkPdf",
  ASSET_SCREENSHOT = "assetScreenshot",
  LINK_FULL_PAGE_ARCHIVE = "linkFullPageArchive",
  LINK_PRECRAWLED_ARCHIVE = "linkPrecrawledArchive",
  LINK_VIDEO = "linkVideo",
  LINK_HTML_CONTENT = "linkHtmlContent",
  BOOKMARK_ASSET = "bookmarkAsset",
  USER_UPLOADED = "userUploaded",
  AVATAR = "avatar",
  BACKUP = "backup",
  UNKNOWN = "unknown",
}

export const assets = sqliteTable(
  "assets",
  {
    // Asset ids don't have a default function as they are generated by the caller
    id: text("id").notNull().primaryKey(),
    assetType: text("assetType", {
      enum: [
        AssetTypes.LINK_BANNER_IMAGE,
        AssetTypes.LINK_SCREENSHOT,
        AssetTypes.LINK_PDF,
        AssetTypes.ASSET_SCREENSHOT,
        AssetTypes.LINK_FULL_PAGE_ARCHIVE,
        AssetTypes.LINK_PRECRAWLED_ARCHIVE,
        AssetTypes.LINK_VIDEO,
        AssetTypes.LINK_HTML_CONTENT,
        AssetTypes.BOOKMARK_ASSET,
        AssetTypes.USER_UPLOADED,
        AssetTypes.AVATAR,
        AssetTypes.BACKUP,
        AssetTypes.UNKNOWN,
      ],
    }).notNull(),
    size: integer("size").notNull().default(0),
    contentType: text("contentType"),
    width: integer("width"),
    height: integer("height"),
    fileName: text("fileName"),
    bookmarkId: text("bookmarkId").references(() => bookmarks.id, {
      onDelete: "cascade",
    }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },

  (tb) => [
    index("assets_bookmarkId_idx").on(tb.bookmarkId),
    index("assets_assetType_idx").on(tb.assetType),
    index("assets_userId_idx").on(tb.userId),
  ],
);

// Hashes describe bytes read from storage at verifiedAt, never URL/title identity.
export const assetContentHashes = sqliteTable(
  "assetContentHashes",
  {
    assetId: text("assetId")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sha256: text("sha256"),
    size: integer("size").notNull(),
    status: text("status", {
      enum: ["verified", "unreadable", "too_large", "changed"],
    }).notNull(),
    verifiedAt: integer("verifiedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (h) => [
    index("assetContentHashes_owner_digest_idx").on(h.userId, h.sha256, h.size),
  ],
);

export const duplicateGroups = sqliteTable(
  "duplicateGroups",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
  },
  (g) => [unique().on(g.userId, g.sha256, g.size)],
);

export const duplicateDecisions = sqliteTable("duplicateDecisions", {
  groupId: text("groupId")
    .primaryKey()
    .references(() => duplicateGroups.id, { onDelete: "cascade" }),
  evidenceVersion: text("evidenceVersion").notNull(),
  decision: text("decision", {
    enum: ["keep_both", "defer", "prefer_primary"],
  }).notNull(),
  primaryBookmarkId: text("primaryBookmarkId").references(() => bookmarks.id, {
    onDelete: "set null",
  }),
  version: integer("version").notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

// One CPU hash reader across server processes. The read deadline is shorter
// than the lease; a fencing token prevents an expired reader publishing results.
export const assetHashScanLease = sqliteTable("assetHashScanLease", {
  id: integer("id").primaryKey(),
  token: text("token").notNull(),
  expiresAt: integer("expiresAt").notNull(),
});

// Immutable source identities and private staged receipts for the bounded copy pilot.
export const importSourceObjects = sqliteTable(
  "importSourceObjects",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accountScope: text("accountScope").notNull(),
    objectId: text("objectId").notNull(),
  },
  (t) => [unique().on(t.userId, t.provider, t.accountScope, t.objectId)],
);
export const importSourceRevisions = sqliteTable(
  "importSourceRevisions",
  {
    id: text("id").primaryKey(),
    sourceObjectId: text("sourceObjectId")
      .notNull()
      .references(() => importSourceObjects.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    payloadDigest: text("payloadDigest").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<
        import("@karakeep/shared/types/deferredImport").ImportReservationInput
      >()
      .notNull(),
    metadataRaw: text("metadataRaw"),
    state: text("state", {
      enum: ["reserved", "verified", "hold", "committed"],
    }).notNull(),
    fencingToken: integer("fencingToken").notNull(),
    leaseUntil: integer("leaseUntil").notNull(),
    bookmarkId: text("bookmarkId").notNull(),
    receipt: text("receipt", { mode: "json" }).$type<
      import("@karakeep/shared/types/deferredImport").ImportReceipt
    >(),
    createdAt: createdAtMsField(),
  },
  (t) => [
    unique().on(t.sourceObjectId, t.revision),
    index("importSourceRevisions_owner_state_idx").on(t.userId, t.state),
  ],
);
export const importReservations = sqliteTable(
  "importReservations",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotencyKey").notNull(),
    payloadDigest: text("payloadDigest").notNull(),
    sourceRevisionId: text("sourceRevisionId")
      .notNull()
      .references(() => importSourceRevisions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.idempotencyKey] })],
);
export const importSourceAttachments = sqliteTable(
  "importSourceAttachments",
  {
    sourceRevisionId: text("sourceRevisionId")
      .notNull()
      .references(() => importSourceRevisions.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    assetId: text("assetId").notNull().unique(),
    // Staged bytes remain outside asset-store enumeration. No automatic GC in v1.
    stageName: text("stageName"),
    state: text("state", { enum: ["pending", "verified", "hold"] }).notNull(),
    detectedMime: text("detectedMime"),
    storedSha256: text("storedSha256"),
    storedSize: integer("storedSize"),
    storageGeneration: text("storageGeneration"),
    verifiedAt: integer("verifiedAt", { mode: "timestamp_ms" }),
  },
  (t) => [primaryKey({ columns: [t.sourceRevisionId, t.slot] })],
);
export const importProcessing = sqliteTable(
  "importProcessing",
  {
    bookmarkId: text("bookmarkId")
      .primaryKey()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    sourceRevisionId: text("sourceRevisionId")
      .notNull()
      .unique()
      .references(() => importSourceRevisions.id),
    userId: text("userId")
      .notNull()
      .references(() => users.id),
    requestId: text("requestId").notNull(),
    stage: text("stage", {
      enum: ["preview", "search", "local_check", "catalog"],
    }).notNull(),
    state: text("state", {
      enum: ["held", "queued", "running", "waiting_ai", "complete", "failed"],
    }).notNull(),
    generation: integer("generation").notNull(),
    policyRevision: integer("policyRevision").notNull(),
    contentRevision: integer("contentRevision").notNull(),
    previewAssetId: text("previewAssetId").notNull().unique(),
    originalWidth: integer("originalWidth"),
    originalHeight: integer("originalHeight"),
    previewReady: integer("previewReady", { mode: "boolean" })
      .notNull()
      .default(false),
    searchReady: integer("searchReady", { mode: "boolean" })
      .notNull()
      .default(false),
    searchRevision: integer("searchRevision").notNull().default(0),
    searchIndexedRevision: integer("searchIndexedRevision")
      .notNull()
      .default(0),
    aiRunId: text("aiRunId"),
    leaseToken: text("leaseToken"),
    leaseUntil: integer("leaseUntil").notNull().default(0),
    error: text("error"),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [
    index("importProcessing_state_updatedAt_idx").on(t.state, t.updatedAt),
    index("importProcessing_leaseUntil_idx").on(t.leaseUntil),
  ],
);
export const processingOutbox = sqliteTable("processingOutbox", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sourceRevisionId: text("sourceRevisionId")
    .notNull()
    .references(() => importSourceRevisions.id, { onDelete: "cascade" })
    .unique(),
  bookmarkId: text("bookmarkId")
    .notNull()
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["import.committed"] }).notNull(),
  state: text("state", { enum: ["held"] }).notNull(),
  policyRevision: integer("policyRevision").notNull(),
  contentRevision: integer("contentRevision").notNull(),
  createdAt: createdAtMsField(),
});

export const highlights = sqliteTable(
  "highlights",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, {
        onDelete: "cascade",
      }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startOffset: integer("startOffset").notNull(),
    endOffset: integer("endOffset").notNull(),
    color: text("color", {
      enum: ["red", "green", "blue", "yellow"],
    })
      .default("yellow")
      .notNull(),
    text: text("text"),
    note: text("note"),
    createdAt: createdAtField(),
  },
  (tb) => [
    index("highlights_bookmarkId_idx").on(tb.bookmarkId),
    index("highlights_userId_idx").on(tb.userId),
  ],
);

export const userReadingProgress = sqliteTable(
  "userReadingProgress",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, {
        onDelete: "cascade",
      }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readingProgressOffset: integer("readingProgressOffset").notNull(),
    readingProgressAnchor: text("readingProgressAnchor"),
    readingProgressPercent: integer("readingProgressPercent"),
    modifiedAt: modifiedAtField(),
  },
  (tb) => [
    unique().on(tb.bookmarkId, tb.userId),
    index("userReadingProgress_bookmarkId_idx").on(tb.bookmarkId),
    index("userReadingProgress_userId_idx").on(tb.userId),
  ],
);

export const bookmarkTexts = sqliteTable("bookmarkTexts", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId())
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  text: text("text"),
  sourceUrl: text("sourceUrl"),
});

export const bookmarkAssets = sqliteTable("bookmarkAssets", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId())
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  assetType: text("assetType", { enum: ["image", "pdf"] }).notNull(),
  assetId: text("assetId").notNull(),
  content: text("content"),
  metadata: text("metadata"),
  fileName: text("fileName"),
  sourceUrl: text("sourceUrl"),
});

export const bookmarkTags = sqliteTable(
  "bookmarkTags",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    normalizedName: text("normalizedName").generatedAlwaysAs(
      (): SQL =>
        // This function needs to be in sync with the tagNormalizer function in tagging.ts
        sql`lower(replace(replace(replace(${bookmarkTags.name}, ' ', ''), '-', ''), '_', ''))`,
      {
        mode: "virtual",
      },
    ),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bt) => [
    unique().on(bt.userId, bt.name),
    unique("bookmarkTags_userId_id_idx").on(bt.userId, bt.id),
    index("bookmarkTags_name_idx").on(bt.name),
    index("bookmarkTags_normalizedName_idx").on(bt.normalizedName),
  ],
);

export const tagsOnBookmarks = sqliteTable(
  "tagsOnBookmarks",
  {
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    tagId: text("tagId")
      .notNull()
      .references(() => bookmarkTags.id, { onDelete: "cascade" }),

    attachedAt: integer("attachedAt", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
    attachedBy: text("attachedBy", { enum: ["ai", "human"] }).notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.bookmarkId, tb.tagId] }),
    // Composite index for tag-first queries (when filtering by tagId)
    index("tagsOnBookmarks_tagId_bookmarkId_idx").on(tb.tagId, tb.bookmarkId),
  ],
);

export const bookmarkLists = sqliteTable(
  "bookmarkLists",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon").notNull(),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["manual", "smart"] }).notNull(),
    // Only applicable for smart lists
    query: text("query"),
    parentId: text("parentId").references(
      (): AnySQLiteColumn => bookmarkLists.id,
      { onDelete: "set null" },
    ),
    // Whoever have access to this token can read the content of this list
    rssToken: text("rssToken"),
    public: integer("public", { mode: "boolean" }).notNull().default(false),
  },
  (bl) => [
    index("bookmarkLists_userId_idx").on(bl.userId),
    unique("bookmarkLists_userId_id_idx").on(bl.userId, bl.id),
  ],
);

export const bookmarksInLists = sqliteTable(
  "bookmarksInLists",
  {
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    addedAt: integer("addedAt", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
    // Tie the list's existence to the user's membership
    // of this list.
    listMembershipId: text("listMembershipId").references(
      () => listCollaborators.id,
      {
        onDelete: "cascade",
      },
    ),
  },
  (tb) => [
    primaryKey({ columns: [tb.bookmarkId, tb.listId] }),
    // Composite index for list-first queries (when filtering by listId)
    index("bookmarksInLists_listId_bookmarkId_idx").on(
      tb.listId,
      tb.bookmarkId,
    ),
  ],
);

export const listCollaborators = sqliteTable(
  "listCollaborators",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    addedAt: createdAtField(),
    addedBy: text("addedBy").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (lc) => [
    unique().on(lc.listId, lc.userId),
    index("listCollaborators_listId_idx").on(lc.listId),
    index("listCollaborators_userId_idx").on(lc.userId),
  ],
);

export const listInvitations = sqliteTable(
  "listInvitations",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    status: text("status", { enum: ["pending", "declined"] })
      .notNull()
      .default("pending"),
    invitedAt: integer("invitedAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    invitedEmail: text("invitedEmail"),
    invitedBy: text("invitedBy").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (li) => [
    unique().on(li.listId, li.userId),
    index("listInvitations_listId_idx").on(li.listId),
    index("listInvitations_userId_idx").on(li.userId),
    index("listInvitations_status_idx").on(li.status),
  ],
);

export const customPrompts = sqliteTable(
  "customPrompts",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    text: text("text").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    appliesTo: text("appliesTo", {
      enum: ["all_tagging", "text", "images", "summary"],
    }).notNull(),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bl) => [index("customPrompts_userId_idx").on(bl.userId)],
);

export const chatSessions = sqliteTable(
  "chatSessions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    title: text("title").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (cs) => [
    index("chatSessions_userId_idx").on(cs.userId),
    index("chatSessions_userId_modifiedAt_idx").on(cs.userId, cs.modifiedAt),
  ],
);

export const chatMessages = sqliteTable(
  "chatMessages",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    chatId: text("chatId")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "toolResult"] }).notNull(),
    content: text("content").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<unknown>(),
    createdAt: createdAtMsField(),
  },
  (cm) => [
    index("chatMessages_chatId_idx").on(cm.chatId),
    index("chatMessages_chatId_createdAt_idx").on(cm.chatId, cm.createdAt),
  ],
);

export const rssFeedsTable = sqliteTable(
  "rssFeeds",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    url: text("url").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    importTags: integer("importTags", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: createdAtField(),
    lastFetchedAt: integer("lastFetchedAt", { mode: "timestamp" }),
    lastSuccessfulFetchAt: integer("lastSuccessfulFetchAt", {
      mode: "timestamp",
    }),
    lastFetchedStatus: text("lastFetchedStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bl) => [index("rssFeeds_userId_idx").on(bl.userId)],
);

export const webhooksTable = sqliteTable(
  "webhooks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    createdAt: createdAtField(),
    url: text("url").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    events: text("events", { mode: "json" })
      .notNull()
      .$type<("created" | "edited" | "crawled" | "ai tagged" | "deleted")[]>(),
    token: text("token"),
  },
  (bl) => [index("webhooks_userId_idx").on(bl.userId)],
);

export const rssFeedImportsTable = sqliteTable(
  "rssFeedImports",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    createdAt: createdAtField(),
    entryId: text("entryId").notNull(),
    rssFeedId: text("rssFeedId")
      .notNull()
      .references(() => rssFeedsTable.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId").references(() => bookmarks.id, {
      onDelete: "set null",
    }),
  },
  (bl) => [
    index("rssFeedImports_feedIdIdx_idx").on(bl.rssFeedId),
    index("rssFeedImports_entryIdIdx_idx").on(bl.entryId),
    unique().on(bl.rssFeedId, bl.entryId),
    index("rssFeedImports_bookmarkId_idx").on(bl.bookmarkId),
    // Composite index for RSS feed filter queries (when filtering by rssFeedId)
    index("rssFeedImports_rssFeedId_bookmarkId_idx").on(
      bl.rssFeedId,
      bl.bookmarkId,
    ),
  ],
);

export const backupsTable = sqliteTable(
  "backups",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: text("assetId").references(() => assets.id, {
      onDelete: "cascade",
    }),
    createdAt: createdAtField(),
    size: integer("size").notNull(),
    bookmarkCount: integer("bookmarkCount").notNull(),
    status: text("status", {
      enum: ["pending", "success", "failure"],
    })
      .notNull()
      .default("pending"),
    errorMessage: text("errorMessage"),
  },
  (b) => [
    index("backups_userId_idx").on(b.userId),
    index("backups_createdAt_idx").on(b.createdAt),
  ],
);

export const config = sqliteTable("config", {
  key: text("key").notNull().primaryKey(),
  value: text("value").notNull(),
});

export const ruleEngineRulesTable = sqliteTable(
  "ruleEngineRules",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    name: text("name").notNull(),
    description: text("description"),
    event: text("event").notNull(),
    condition: text("condition").notNull(),

    // References
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tagId: text("tagId"),
  },
  (rl) => [
    index("ruleEngine_userId_idx").on(rl.userId),

    // Ensures correct ownership
    foreignKey({
      columns: [rl.userId, rl.tagId],
      foreignColumns: [bookmarkTags.userId, bookmarkTags.id],
      name: "ruleEngineRules_userId_tagId_fk",
    }).onDelete("cascade"),
  ],
);

export const ruleEngineActionsTable = sqliteTable(
  "ruleEngineActions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ruleId: text("ruleId")
      .notNull()
      .references(() => ruleEngineRulesTable.id, { onDelete: "cascade" }),
    action: text("action").notNull(),

    // References
    listId: text("listId"),
    tagId: text("tagId"),
  },
  (rl) => [
    index("ruleEngineActions_userId_idx").on(rl.userId),
    index("ruleEngineActions_ruleId_idx").on(rl.ruleId),
    // Ensures correct ownership
    foreignKey({
      columns: [rl.userId, rl.tagId],
      foreignColumns: [bookmarkTags.userId, bookmarkTags.id],
      name: "ruleEngineActions_userId_tagId_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [rl.userId, rl.listId],
      foreignColumns: [bookmarkLists.userId, bookmarkLists.id],
      name: "ruleEngineActions_userId_listId_fk",
    }).onDelete("cascade"),
  ],
);

export const invites = sqliteTable("invites", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAtField(),
  usedAt: integer("usedAt", { mode: "timestamp" }),
  invitedBy: text("invitedBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
    stripeCustomerId: text("stripeCustomerId").notNull(),
    stripeSubscriptionId: text("stripeSubscriptionId"),
    status: text("status", {
      enum: [
        "active",
        "canceled",
        "past_due",
        "unpaid",
        "incomplete",
        "trialing",
        "incomplete_expired",
        "paused",
      ],
    }).notNull(),
    tier: text("tier", {
      enum: ["free", "paid"],
    })
      .notNull()
      .default("free"),
    priceId: text("priceId"),
    cancelAtPeriodEnd: integer("cancelAtPeriodEnd", {
      mode: "boolean",
    }).default(false),
    startDate: integer("startDate", { mode: "timestamp" }),
    endDate: integer("endDate", { mode: "timestamp" }),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
  },
  (s) => [
    index("subscriptions_userId_idx").on(s.userId),
    index("subscriptions_stripeCustomerId_idx").on(s.stripeCustomerId),
  ],
);

export const importSessions = sqliteTable(
  "importSessions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message"),
    rootListId: text("rootListId").references(() => bookmarkLists.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: [
        "staging",
        "pending",
        "running",
        "paused",
        "completed",
        "failed",
        "archived",
      ],
    })
      .notNull()
      .default("staging"),
    lastProcessedAt: integer("lastProcessedAt", { mode: "timestamp" }),
    completedAt: integer("completedAt", { mode: "timestamp" }),
    totalBookmarks: integer("totalBookmarks").notNull().default(0),
    completedBookmarks: integer("completedBookmarks").notNull().default(0),
    failedBookmarks: integer("failedBookmarks").notNull().default(0),
    pendingBookmarks: integer("pendingBookmarks").notNull().default(0),
    processingBookmarks: integer("processingBookmarks").notNull().default(0),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
  },
  (is) => [
    index("importSessions_userId_idx").on(is.userId),
    index("importSessions_status_idx").on(is.status),
    index("importSessions_status_completedAt_idx").on(
      is.status,
      is.completedAt,
    ),
  ],
);

export const importSessionBookmarks = sqliteTable(
  "importSessionBookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    importSessionId: text("importSessionId")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    createdAt: createdAtField(),
  },
  (isb) => [
    index("importSessionBookmarks_bookmarkId_idx").on(isb.bookmarkId),
    unique().on(isb.importSessionId, isb.bookmarkId),
  ],
);

export const importStagingBookmarks = sqliteTable(
  "importStagingBookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    importSessionId: text("importSessionId")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),

    // Bookmark data to create
    type: text("type", { enum: ["link", "text", "asset"] }).notNull(),
    url: text("url"),
    title: text("title"),
    content: text("content"),
    note: text("note"),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    listIds: text("listIds", { mode: "json" }).$type<string[]>(),
    sourceAddedAt: integer("sourceAddedAt", { mode: "timestamp" }),
    archived: integer("archived", { mode: "boolean" }),

    // Processing state
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    processingStartedAt: integer("processingStartedAt", {
      mode: "timestamp",
    }),

    // Result (for observability)
    result: text("result", {
      enum: ["accepted", "rejected", "skipped_duplicate"],
    }),
    resultReason: text("resultReason"),
    resultBookmarkId: text("resultBookmarkId").references(() => bookmarks.id, {
      onDelete: "set null",
    }),

    createdAt: createdAtField(),
    completedAt: integer("completedAt", { mode: "timestamp" }),
  },
  (isb) => [
    index("importStaging_session_status_idx").on(
      isb.importSessionId,
      isb.status,
    ),
    index("importStaging_completedAt_idx").on(isb.completedAt),
    index("importStaging_resultBookmarkId_idx").on(isb.resultBookmarkId),
    index("importStaging_status_idx").on(isb.status),
    index("importStaging_status_processingStartedAt_idx").on(
      isb.status,
      isb.processingStartedAt,
    ),
  ],
);

// Relations

export const userRelations = relations(users, ({ many, one }) => ({
  tags: many(bookmarkTags),
  bookmarks: many(bookmarks),
  webhooks: many(webhooksTable),
  rules: many(ruleEngineRulesTable),
  chatSessions: many(chatSessions),
  invites: many(invites),
  subscription: one(subscriptions),
  importSessions: many(importSessions),
  listCollaborations: many(listCollaborators),
  backups: many(backupsTable),
  listInvitations: many(listInvitations),
}));

export const bookmarkRelations = relations(bookmarks, ({ many, one }) => ({
  importProcessing: one(importProcessing, {
    fields: [bookmarks.id],
    references: [importProcessing.bookmarkId],
  }),
  user: one(users, {
    fields: [bookmarks.userId],
    references: [users.id],
  }),
  link: one(bookmarkLinks, {
    fields: [bookmarks.id],
    references: [bookmarkLinks.id],
  }),
  text: one(bookmarkTexts, {
    fields: [bookmarks.id],
    references: [bookmarkTexts.id],
  }),
  asset: one(bookmarkAssets, {
    fields: [bookmarks.id],
    references: [bookmarkAssets.id],
  }),
  tagsOnBookmarks: many(tagsOnBookmarks),
  bookmarksInLists: many(bookmarksInLists),
  assets: many(assets),
  rssFeeds: many(rssFeedImportsTable),
  importSessionBookmarks: many(importSessionBookmarks),
}));

export const assetRelations = relations(assets, ({ one }) => ({
  bookmark: one(bookmarks, {
    fields: [assets.bookmarkId],
    references: [bookmarks.id],
  }),
}));

export const bookmarkTagsRelations = relations(
  bookmarkTags,
  ({ many, one }) => ({
    user: one(users, {
      fields: [bookmarkTags.userId],
      references: [users.id],
    }),
    tagsOnBookmarks: many(tagsOnBookmarks),
  }),
);

export const tagsOnBookmarksRelations = relations(
  tagsOnBookmarks,
  ({ one }) => ({
    tag: one(bookmarkTags, {
      fields: [tagsOnBookmarks.tagId],
      references: [bookmarkTags.id],
    }),
    bookmark: one(bookmarks, {
      fields: [tagsOnBookmarks.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const bookmarkListsRelations = relations(
  bookmarkLists,
  ({ one, many }) => ({
    bookmarksInLists: many(bookmarksInLists),
    collaborators: many(listCollaborators),
    invitations: many(listInvitations),
    user: one(users, {
      fields: [bookmarkLists.userId],
      references: [users.id],
    }),
    parent: one(bookmarkLists, {
      fields: [bookmarkLists.parentId],
      references: [bookmarkLists.id],
    }),
  }),
);

export const bookmarksInListsRelations = relations(
  bookmarksInLists,
  ({ one }) => ({
    bookmark: one(bookmarks, {
      fields: [bookmarksInLists.bookmarkId],
      references: [bookmarks.id],
    }),
    list: one(bookmarkLists, {
      fields: [bookmarksInLists.listId],
      references: [bookmarkLists.id],
    }),
  }),
);

export const listCollaboratorsRelations = relations(
  listCollaborators,
  ({ one }) => ({
    list: one(bookmarkLists, {
      fields: [listCollaborators.listId],
      references: [bookmarkLists.id],
    }),
    user: one(users, {
      fields: [listCollaborators.userId],
      references: [users.id],
    }),
    addedByUser: one(users, {
      fields: [listCollaborators.addedBy],
      references: [users.id],
    }),
  }),
);

export const listInvitationsRelations = relations(
  listInvitations,
  ({ one }) => ({
    list: one(bookmarkLists, {
      fields: [listInvitations.listId],
      references: [bookmarkLists.id],
    }),
    user: one(users, {
      fields: [listInvitations.userId],
      references: [users.id],
    }),
    invitedByUser: one(users, {
      fields: [listInvitations.invitedBy],
      references: [users.id],
    }),
  }),
);

export const webhooksRelations = relations(webhooksTable, ({ one }) => ({
  user: one(users, {
    fields: [webhooksTable.userId],
    references: [users.id],
  }),
}));

export const ruleEngineRulesRelations = relations(
  ruleEngineRulesTable,
  ({ one, many }) => ({
    user: one(users, {
      fields: [ruleEngineRulesTable.userId],
      references: [users.id],
    }),
    actions: many(ruleEngineActionsTable),
  }),
);

export const ruleEngineActionsTableRelations = relations(
  ruleEngineActionsTable,
  ({ one }) => ({
    rule: one(ruleEngineRulesTable, {
      fields: [ruleEngineActionsTable.ruleId],
      references: [ruleEngineRulesTable.id],
    }),
  }),
);

export const rssFeedImportsTableRelations = relations(
  rssFeedImportsTable,
  ({ one }) => ({
    rssFeed: one(rssFeedsTable, {
      fields: [rssFeedImportsTable.rssFeedId],
      references: [rssFeedsTable.id],
    }),
    bookmark: one(bookmarks, {
      fields: [rssFeedImportsTable.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const invitesRelations = relations(invites, ({ one }) => ({
  invitedBy: one(users, {
    fields: [invites.invitedBy],
    references: [users.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

export const passwordResetTokensRelations = relations(
  passwordResetTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [passwordResetTokens.userId],
      references: [users.id],
    }),
  }),
);

export const chatSessionsRelations = relations(
  chatSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [chatSessions.userId],
      references: [users.id],
    }),
    messages: many(chatMessages),
  }),
);

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  chat: one(chatSessions, {
    fields: [chatMessages.chatId],
    references: [chatSessions.id],
  }),
}));

export const importSessionsRelations = relations(
  importSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [importSessions.userId],
      references: [users.id],
    }),
    bookmarks: many(importSessionBookmarks),
  }),
);

export const importSessionBookmarksRelations = relations(
  importSessionBookmarks,
  ({ one }) => ({
    importSession: one(importSessions, {
      fields: [importSessionBookmarks.importSessionId],
      references: [importSessions.id],
    }),
    bookmark: one(bookmarks, {
      fields: [importSessionBookmarks.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const backupsRelations = relations(backupsTable, ({ one }) => ({
  user: one(users, {
    fields: [backupsTable.userId],
    references: [users.id],
  }),
  asset: one(assets, {
    fields: [backupsTable.assetId],
    references: [assets.id],
  }),
}));

export const userReadingProgressRelations = relations(
  userReadingProgress,
  ({ one }) => ({
    bookmark: one(bookmarks, {
      fields: [userReadingProgress.bookmarkId],
      references: [bookmarks.id],
    }),
    user: one(users, {
      fields: [userReadingProgress.userId],
      references: [users.id],
    }),
  }),
);

// A durable request reservation; deleting a bookmark does not refund the daily quota.
export const mediaAiRequests = sqliteTable(
  "mediaAiRequests",
  {
    id: text("id").primaryKey(),
    bookmarkId: text("bookmarkId").notNull(),
    userId: text("userId").notNull(),
    day: text("day").notNull(),
  },
  (t) => [index("mediaAiRequests_day_idx").on(t.day)],
);

export const mediaAiControl = sqliteTable("mediaAiControl", {
  id: integer("id").primaryKey(),
  cloudMode: text("cloudMode", { enum: ["off", "manual", "auto"] }).notNull(),
  dailyRequests: integer("dailyRequests").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const mediaAiRuns = sqliteTable(
  "mediaAiRuns",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    createdAt: text("createdAt").notNull(),
    completedAt: text("completedAt"),
    snapshot: text("snapshot", { mode: "json" })
      .$type<MediaCatalogState>()
      .notNull(),
  },
  (t) => [index("mediaAiRuns_bookmark_idx").on(t.bookmarkId, t.createdAt)],
);

export const mediaAiBatches = sqliteTable(
  "mediaAiBatches",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["draft", "running", "paused", "cancelled", "complete"],
    }).notNull(),
    provider: text("provider", { enum: ["xai", "openai"] }).notNull(),
    request: text("request", { mode: "json" })
      .$type<AiBatchRequest>()
      .notNull(),
    entries: text("entries", { mode: "json" })
      .$type<AiBatchEntry[]>()
      .notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [index("mediaAiBatches_user_idx").on(t.userId, t.createdAt)],
);
