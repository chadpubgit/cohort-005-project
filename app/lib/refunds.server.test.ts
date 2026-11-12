import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  getDecidedRefundRequestsForLearner,
  listOpenRefundRequests,
} from "~/lib/refunds.server";

type TestDb = ReturnType<typeof createTestDb>;

function setup() {
  const db = createTestDb();
  const base = seedBaseData(db);

  const admin = db
    .insert(schema.users)
    .values({ name: "Admin", email: "admin@example.com", role: schema.UserRole.Admin })
    .returning()
    .get();

  const courseModule = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();

  const lessonIds = [1, 2, 3, 4].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: courseModule.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );

  return { db, ...base, admin, lessonIds };
}

function buyAndRequest(
  db: TestDb,
  input: { userId: number; courseId: number; amountPaid?: number; requestedAt?: string }
) {
  const purchase = db
    .insert(schema.purchases)
    .values({ userId: input.userId, courseId: input.courseId, amountPaid: input.amountPaid ?? 7900 })
    .returning()
    .get();

  db.insert(schema.enrollments)
    .values({ userId: input.userId, courseId: input.courseId })
    .run();

  const refundRequest = db
    .insert(schema.refunds)
    .values({
      purchaseId: purchase.id,
      reason: "Bought the wrong one, sorry.",
      ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
    })
    .returning()
    .get();

  return { purchase, refundRequest };
}

function getRefund(db: TestDb, id: number) {
  return db.select().from(schema.refunds).where(eq(schema.refunds.id, id)).get();
}

function enrollmentCount(db: TestDb, userId: number, courseId: number) {
  return db
    .select()
    .from(schema.enrollments)
    .where(and(eq(schema.enrollments.userId, userId), eq(schema.enrollments.courseId, courseId)))
    .all().length;
}

describe("listOpenRefundRequests", () => {
  it("lists only open requests, oldest first, with the learner's progress", () => {
    const { db, user, course, admin, lessonIds } = setup();

    const other = db
      .insert(schema.users)
      .values({ name: "Other", email: "other@example.com", role: schema.UserRole.Student })
      .returning()
      .get();

    const newer = buyAndRequest(db, {
      userId: user.id,
      courseId: course.id,
      requestedAt: "2026-11-10T10:00:00.000Z",
    });
    const older = buyAndRequest(db, {
      userId: other.id,
      courseId: course.id,
      amountPaid: 3950,
      requestedAt: "2026-11-01T10:00:00.000Z",
    });
    const decided = buyAndRequest(db, { userId: admin.id, courseId: course.id });
    declineRefundRequest(db, { refundRequestId: decided.refundRequest.id, adminUserId: admin.id });

    db.insert(schema.lessonProgress)
      .values([
        { userId: user.id, lessonId: lessonIds[0], status: schema.LessonProgressStatus.Completed },
        { userId: user.id, lessonId: lessonIds[1], status: schema.LessonProgressStatus.InProgress },
      ])
      .run();
    db.insert(schema.videoWatchEvents)
      .values([
        { userId: user.id, lessonId: lessonIds[0], eventType: "progress", positionSeconds: 100 },
        { userId: user.id, lessonId: lessonIds[0], eventType: "progress", positionSeconds: 300 },
        { userId: user.id, lessonId: lessonIds[1], eventType: "progress", positionSeconds: 60 },
      ])
      .run();

    const list = listOpenRefundRequests(db);

    expect(list.map((r) => r.id)).toEqual([older.refundRequest.id, newer.refundRequest.id]);

    const liam = list[1];
    expect(liam).toMatchObject({
      reason: "Bought the wrong one, sorry.",
      amountPaid: 7900,
      learner: { id: user.id, name: user.name, email: user.email },
      course: { id: course.id, title: course.title, slug: course.slug },
      completedLessons: 1,
      totalLessons: 4,
      completionPercent: 25,
      watchedSeconds: 360,
      flags: { watchedOverLimit: false, completedOverLimit: false, seatClaimed: false },
    });
  });

  it("flags requests that are now outside the rules", () => {
    const { db, user, course, lessonIds } = setup();
    const { purchase } = buyAndRequest(db, { userId: user.id, courseId: course.id });

    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: user.id,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
        }))
      )
      .run();
    db.insert(schema.videoWatchEvents)
      .values({ userId: user.id, lessonId: lessonIds[0], eventType: "progress", positionSeconds: 7200 })
      .run();

    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: user.id,
        redeemedAt: new Date().toISOString(),
      })
      .run();

    const [request] = listOpenRefundRequests(db);

    expect(request.flags).toEqual({
      watchedOverLimit: true,
      completedOverLimit: true,
      seatClaimed: true,
    });
  });
});

describe("approveRefundRequest", () => {
  it("approves for the full amount paid and removes the learner's access, keeping progress", () => {
    const { db, user, course, admin, lessonIds } = setup();
    const { refundRequest } = buyAndRequest(db, { userId: user.id, courseId: course.id, amountPaid: 4200 });
    db.insert(schema.lessonProgress)
      .values({ userId: user.id, lessonId: lessonIds[0], status: schema.LessonProgressStatus.Completed })
      .run();

    const result = approveRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id });

    expect(result).toMatchObject({
      outcome: "approved",
      amountRefunded: 4200,
      accessRemoved: true,
      learner: { id: user.id, email: user.email },
      course: { id: course.id, title: course.title },
    });

    const refund = getRefund(db, refundRequest.id);
    expect(refund?.status).toBe(schema.RefundStatus.Approved);
    expect(refund?.amountRefunded).toBe(4200);
    expect(refund?.resolvedByUserId).toBe(admin.id);
    expect(refund?.resolvedAt).toEqual(expect.any(String));

    expect(enrollmentCount(db, user.id, course.id)).toBe(0);
    expect(
      db.select().from(schema.lessonProgress).where(eq(schema.lessonProgress.userId, user.id)).all()
    ).toHaveLength(1);
  });

  it("keeps access when another purchase without an approved refund still gives it", () => {
    const { db, user, course, admin } = setup();
    const first = buyAndRequest(db, { userId: user.id, courseId: course.id });
    db.insert(schema.purchases)
      .values({ userId: user.id, courseId: course.id, amountPaid: 7900 })
      .run();

    const result = approveRefundRequest(db, { refundRequestId: first.refundRequest.id, adminUserId: admin.id });

    expect(result).toMatchObject({ outcome: "approved", accessRemoved: false });
    expect(enrollmentCount(db, user.id, course.id)).toBe(1);
  });

  it("removes access when the other purchase was itself refunded", () => {
    const { db, user, course, admin } = setup();
    const first = buyAndRequest(db, { userId: user.id, courseId: course.id });
    const second = buyAndRequest(db, { userId: user.id, courseId: course.id });
    approveRefundRequest(db, { refundRequestId: first.refundRequest.id, adminUserId: admin.id });

    const result = approveRefundRequest(db, { refundRequestId: second.refundRequest.id, adminUserId: admin.id });

    expect(result).toMatchObject({ outcome: "approved", accessRemoved: true });
    expect(enrollmentCount(db, user.id, course.id)).toBe(0);
  });

  it("keeps access when the learner holds a redeemed team seat for the course", () => {
    const { db, user, course, admin, instructor } = setup();
    const { refundRequest } = buyAndRequest(db, { userId: user.id, courseId: course.id });

    const teamPurchase = db
      .insert(schema.purchases)
      .values({ userId: instructor.id, courseId: course.id, amountPaid: 15800 })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: teamPurchase.id,
        redeemedByUserId: user.id,
        redeemedAt: new Date().toISOString(),
      })
      .run();

    const result = approveRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id });

    expect(result).toMatchObject({ outcome: "approved", accessRemoved: false });
    expect(enrollmentCount(db, user.id, course.id)).toBe(1);
  });

  it("deletes the purchase's unused seat codes and leaves claimed ones alone", () => {
    const { db, user, course, admin } = setup();
    const { purchase, refundRequest } = buyAndRequest(db, { userId: user.id, courseId: course.id });
    const team = db.insert(schema.teams).values({}).returning().get();
    const claimer = db
      .insert(schema.users)
      .values({ name: "Claimer", email: "claimer@example.com", role: schema.UserRole.Student })
      .returning()
      .get();
    db.insert(schema.coupons)
      .values([
        { teamId: team.id, courseId: course.id, code: "UNUSED-1", purchaseId: purchase.id },
        { teamId: team.id, courseId: course.id, code: "UNUSED-2", purchaseId: purchase.id },
        {
          teamId: team.id,
          courseId: course.id,
          code: "CLAIMED",
          purchaseId: purchase.id,
          redeemedByUserId: claimer.id,
          redeemedAt: new Date().toISOString(),
        },
      ])
      .run();

    approveRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id });

    const remaining = db
      .select({ code: schema.coupons.code })
      .from(schema.coupons)
      .where(eq(schema.coupons.purchaseId, purchase.id))
      .all();
    expect(remaining).toEqual([{ code: "CLAIMED" }]);
  });

  it("refuses a request that has already been decided, and changes nothing", () => {
    const { db, user, course, admin } = setup();
    const { refundRequest } = buyAndRequest(db, { userId: user.id, courseId: course.id });
    declineRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id });

    const result = approveRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id });

    expect(result).toEqual({ outcome: "already-decided" });
    expect(getRefund(db, refundRequest.id)?.status).toBe(schema.RefundStatus.Declined);
    expect(enrollmentCount(db, user.id, course.id)).toBe(1);
  });

  it("reports a request that does not exist", () => {
    const { db, admin } = setup();

    expect(approveRefundRequest(db, { refundRequestId: 999, adminUserId: admin.id })).toEqual({
      outcome: "not-found",
    });
  });
});

describe("declineRefundRequest", () => {
  it("declines without refunding anything and keeps access", () => {
    const { db, user, course, admin } = setup();
    const { refundRequest } = buyAndRequest(db, { userId: user.id, courseId: course.id });

    const result = declineRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id });

    expect(result).toMatchObject({
      outcome: "declined",
      learner: { id: user.id },
      course: { id: course.id },
    });
    const refund = getRefund(db, refundRequest.id);
    expect(refund?.status).toBe(schema.RefundStatus.Declined);
    expect(refund?.amountRefunded).toBeNull();
    expect(refund?.resolvedByUserId).toBe(admin.id);
    expect(enrollmentCount(db, user.id, course.id)).toBe(1);
  });

  it("refuses a request that has already been decided", () => {
    const { db, user, course, admin } = setup();
    const { refundRequest } = buyAndRequest(db, { userId: user.id, courseId: course.id });
    approveRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id });

    expect(declineRefundRequest(db, { refundRequestId: refundRequest.id, adminUserId: admin.id })).toEqual({
      outcome: "already-decided",
    });
    expect(getRefund(db, refundRequest.id)?.status).toBe(schema.RefundStatus.Approved);
  });
});

describe("getDecidedRefundRequestsForLearner", () => {
  it("returns the latest decision per purchase, skipping purchases with an open request", () => {
    const { db, user, course, admin } = setup();

    const approved = buyAndRequest(db, { userId: user.id, courseId: course.id, amountPaid: 7900 });
    approveRefundRequest(db, { refundRequestId: approved.refundRequest.id, adminUserId: admin.id });

    const reopened = buyAndRequest(db, { userId: user.id, courseId: course.id });
    declineRefundRequest(db, { refundRequestId: reopened.refundRequest.id, adminUserId: admin.id });
    db.insert(schema.refunds)
      .values({ purchaseId: reopened.purchase.id, reason: "Asking again, please." })
      .run();

    const decided = getDecidedRefundRequestsForLearner(db, user.id);

    expect(decided).toEqual([
      expect.objectContaining({
        id: approved.refundRequest.id,
        status: schema.RefundStatus.Approved,
        amountRefunded: 7900,
        courseTitle: course.title,
        courseSlug: course.slug,
      }),
    ]);
  });
});
