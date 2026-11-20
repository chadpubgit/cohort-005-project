import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./bookmarks-notes.server";
import { MAX_NOTE_LENGTH } from "./notes";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesAfter(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

describe("toggling a Bookmark", () => {
  it("adds a Bookmark to a Lesson that has none", () => {
    const now = toggleBookmark(db, base.user.id, lessonIds[0], NOW);

    expect(now).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
  });

  it("removes the Bookmark when toggled again", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    const now = toggleBookmark(db, base.user.id, lessonIds[0], NOW);

    expect(now).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on a Lesson", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    db.insert(schema.bookmarks)
      .values({ userId: base.user.id, lessonId: lessonIds[0] })
      .onConflictDoNothing()
      .run();

    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
  });

  it("does not touch another Student's Bookmark on the same Lesson", () => {
    const other = addStudent("Other");
    toggleBookmark(db, other.id, lessonIds[0], NOW);

    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);

    expect(isBookmarked(db, other.id, lessonIds[0])).toBe(true);
  });
});

describe("saving a Note", () => {
  it("creates a Note on a Lesson that has none", () => {
    const result = saveNote(db, base.user.id, lessonIds[0], "First thoughts", NOW);

    expect(result).toMatchObject({
      ok: true,
      note: {
        userId: base.user.id,
        lessonId: lessonIds[0],
        body: "First thoughts",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
  });

  it("replaces the body and moves the last edited time on when saved again", () => {
    saveNote(db, base.user.id, lessonIds[0], "First thoughts", NOW);
    saveNote(db, base.user.id, lessonIds[0], "Better thoughts", minutesAfter(5));

    expect(getNote(db, base.user.id, lessonIds[0])).toMatchObject({
      body: "Better thoughts",
      createdAt: NOW.toISOString(),
      updatedAt: minutesAfter(5).toISOString(),
    });
  });

  it("never leaves a Student with two Notes on a Lesson", () => {
    saveNote(db, base.user.id, lessonIds[0], "One", NOW);
    saveNote(db, base.user.id, lessonIds[0], "Two", minutesAfter(1));

    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("keeps the body as plain text, trimmed", () => {
    saveNote(db, base.user.id, lessonIds[0], "  # not a heading *or bold*  ", NOW);

    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe(
      "# not a heading *or bold*"
    );
  });

  it("accepts a Note of exactly 2,000 characters", () => {
    const result = saveNote(
      db,
      base.user.id,
      lessonIds[0],
      "a".repeat(MAX_NOTE_LENGTH),
      NOW
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a Note over 2,000 characters and keeps the old one", () => {
    saveNote(db, base.user.id, lessonIds[0], "Keep me", NOW);

    const result = saveNote(
      db,
      base.user.id,
      lessonIds[0],
      "a".repeat(MAX_NOTE_LENGTH + 1),
      minutesAfter(1)
    );

    expect(result).toEqual({
      ok: false,
      error: "A note can be at most 2,000 characters.",
    });
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Keep me");
  });

  it("refuses a Note that is only whitespace", () => {
    const result = saveNote(db, base.user.id, lessonIds[0], "   ", NOW);

    expect(result).toEqual({ ok: false, error: "Enter a note before saving." });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });
});

describe("the Saved lists", () => {
  it("lists a Student's Bookmarks newest first, with their Lesson and Course", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[2], minutesAfter(10));
    toggleBookmark(db, base.user.id, lessonIds[1], minutesAfter(5));

    expect(listBookmarks(db, base.user.id)).toMatchObject([
      {
        lessonId: lessonIds[2],
        lessonTitle: "Lesson 3",
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
      },
      { lessonId: lessonIds[1] },
      { lessonId: lessonIds[0] },
    ]);
  });

  it("lists a Student's Notes by last edited time, newest first", () => {
    saveNote(db, base.user.id, lessonIds[0], "Oldest", NOW);
    saveNote(db, base.user.id, lessonIds[1], "Middle", minutesAfter(5));
    saveNote(db, base.user.id, lessonIds[0], "Edited last", minutesAfter(10));

    expect(listNotes(db, base.user.id)).toMatchObject([
      {
        lessonId: lessonIds[0],
        body: "Edited last",
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
      },
      { lessonId: lessonIds[1], body: "Middle" },
    ]);
  });

  it("contains only the Student's own rows", () => {
    const other = addStudent("Other");
    toggleBookmark(db, other.id, lessonIds[0], NOW);
    saveNote(db, other.id, lessonIds[0], "Not yours", NOW);

    expect(listBookmarks(db, base.user.id)).toEqual([]);
    expect(listNotes(db, base.user.id)).toEqual([]);
  });
});

describe("approving a Refund Request", () => {
  it("leaves the Student's Bookmarks and Notes in place", async () => {
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    const admin = db
      .insert(schema.users)
      .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
      .returning()
      .get();
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    saveNote(db, base.user.id, lessonIds[0], "Keep me", NOW);
    const notifications = fakeNotifications();

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "It was not what I expected.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      NOW,
      notifications
    );

    expect(approved.ok).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Keep me");
  });
});
