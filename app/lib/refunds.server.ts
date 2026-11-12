import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { RunResult } from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "~/db/schema";
import {
  LessonProgressStatus,
  RefundStatus,
  coupons,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// The app's database, a test database, or a transaction on either.
type Db = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

// The same limits the learner is held to when they ask. Here they only flag a
// request for the admin; they never stop an approval.
const WATCH_LIMIT_SECONDS = 2 * 60 * 60;
const COMPLETION_LIMIT = 0.5;

function getCourseLessonIds(db: Db, courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(db: Db, userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(distinct ${lessonProgress.lessonId})` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(db: Db, userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({ furthest: sql<number>`max(${videoWatchEvents.positionSeconds})` })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function hasClaimedSeat(db: Db, purchaseId: number) {
  return Boolean(
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt)))
      .get()
  );
}

/**
 * Every Open Refund Request, oldest first, with what the admin needs to
 * decide it: who, what, how much, and how far into the course they are now.
 */
export function listOpenRefundRequests(db: Db) {
  const rows = db
    .select({
      id: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => {
    const lessonIds = getCourseLessonIds(db, row.courseId);
    const totalLessons = lessonIds.length;
    const completedLessons = getCompletedLessonCount(db, row.learnerId, lessonIds);
    const watchedSeconds = getSecondsWatched(db, row.learnerId, lessonIds);
    const completionRatio = totalLessons === 0 ? 0 : completedLessons / totalLessons;

    return {
      id: row.id,
      reason: row.reason,
      requestedAt: row.requestedAt,
      amountPaid: row.amountPaid,
      purchasedAt: row.purchasedAt,
      learner: { id: row.learnerId, name: row.learnerName, email: row.learnerEmail },
      course: { id: row.courseId, title: row.courseTitle, slug: row.courseSlug },
      completedLessons,
      totalLessons,
      completionPercent: Math.round(completionRatio * 100),
      watchedSeconds,
      flags: {
        watchedOverLimit: watchedSeconds >= WATCH_LIMIT_SECONDS,
        completedOverLimit: completionRatio >= COMPLETION_LIMIT,
        seatClaimed: hasClaimedSeat(db, row.purchaseId),
      },
    };
  });
}

export type OpenRefundRequest = ReturnType<typeof listOpenRefundRequests>[number];

type DecisionInput = { refundRequestId: number; adminUserId: number };

type DecisionSubject = {
  learner: { id: number; name: string; email: string };
  course: { id: number; title: string; slug: string };
};

type Undecidable = { outcome: "not-found" } | { outcome: "already-decided" };

export type ApproveResult =
  | Undecidable
  | ({ outcome: "approved"; amountRefunded: number; accessRemoved: boolean } & DecisionSubject);

export type DeclineResult = Undecidable | ({ outcome: "declined" } & DecisionSubject);

function findRequestToDecide(db: Db, refundRequestId: number) {
  return db
    .select({
      status: refunds.status,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      learner: { id: users.id, name: users.name, email: users.email },
      course: { id: courses.id, title: courses.title, slug: courses.slug },
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();
}

/**
 * Resolves the request only if it is still open, so two admins acting at once
 * cannot both decide it. Returns false when someone else got there first.
 */
function resolveIfOpen(
  db: Db,
  input: DecisionInput & { status: RefundStatus; amountRefunded: number | null }
) {
  const resolved = db
    .update(refunds)
    .set({
      status: input.status,
      amountRefunded: input.amountRefunded,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: input.adminUserId,
    })
    .where(and(eq(refunds.id, input.refundRequestId), eq(refunds.status, RefundStatus.Open)))
    .returning({ id: refunds.id })
    .get();

  return Boolean(resolved);
}

/**
 * Whether anything other than the refunded purchase still gives the learner
 * the course: another purchase of their own with no approved refund (team
 * purchases don't count, they give seats rather than access), or a team seat
 * they have redeemed.
 */
function hasOtherAccess(db: Db, input: { userId: number; courseId: number; refundedPurchaseId: number }) {
  const otherPurchase = db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.userId, input.userId),
        eq(purchases.courseId, input.courseId),
        ne(purchases.id, input.refundedPurchaseId),
        sql`not exists (select 1 from ${refunds} where ${refunds.purchaseId} = ${purchases.id} and ${refunds.status} = ${RefundStatus.Approved})`,
        sql`not exists (select 1 from ${coupons} where ${coupons.purchaseId} = ${purchases.id})`
      )
    )
    .get();

  if (otherPurchase) return true;

  const redeemedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(
        eq(coupons.redeemedByUserId, input.userId),
        eq(coupons.courseId, input.courseId),
        isNotNull(coupons.redeemedAt)
      )
    )
    .get();

  return Boolean(redeemedSeat);
}

/**
 * Approves an Open Refund Request for the full amount paid. In the same
 * transaction it deletes the purchase's unclaimed seat codes and, unless
 * something else still gives the learner the course, their enrollment.
 * Progress is kept. See docs/adr/0001-approving-a-refund-deletes-the-enrollment.md.
 */
export function approveRefundRequest(db: Db, input: DecisionInput): ApproveResult {
  return db.transaction((tx) => {
    const request = findRequestToDecide(tx, input.refundRequestId);

    if (!request) return { outcome: "not-found" };
    if (request.status !== RefundStatus.Open) return { outcome: "already-decided" };

    const resolved = resolveIfOpen(tx, {
      ...input,
      status: RefundStatus.Approved,
      amountRefunded: request.amountPaid,
    });

    if (!resolved) return { outcome: "already-decided" };

    tx.delete(coupons)
      .where(and(eq(coupons.purchaseId, request.purchaseId), isNull(coupons.redeemedAt)))
      .run();

    const keepsAccess = hasOtherAccess(tx, {
      userId: request.learner.id,
      courseId: request.course.id,
      refundedPurchaseId: request.purchaseId,
    });

    if (!keepsAccess) {
      tx.delete(enrollments)
        .where(
          and(
            eq(enrollments.userId, request.learner.id),
            eq(enrollments.courseId, request.course.id)
          )
        )
        .run();
    }

    return {
      outcome: "approved",
      amountRefunded: request.amountPaid,
      accessRemoved: !keepsAccess,
      learner: request.learner,
      course: request.course,
    };
  });
}

/** Declines an Open Refund Request. Nothing is refunded and access is kept. */
export function declineRefundRequest(db: Db, input: DecisionInput): DeclineResult {
  return db.transaction((tx) => {
    const request = findRequestToDecide(tx, input.refundRequestId);

    if (!request) return { outcome: "not-found" };
    if (request.status !== RefundStatus.Open) return { outcome: "already-decided" };

    const resolved = resolveIfOpen(tx, {
      ...input,
      status: RefundStatus.Declined,
      amountRefunded: null,
    });

    if (!resolved) return { outcome: "already-decided" };

    return { outcome: "declined", learner: request.learner, course: request.course };
  });
}

/**
 * The latest decided Refund Request on each of the learner's purchases,
 * newest first. A purchase with an Open Refund Request is left out: the open
 * one is what the learner is waiting on now.
 */
export function getDecidedRefundRequestsForLearner(db: Db, userId: number) {
  const rows = db
    .select({
      id: refunds.id,
      purchaseId: refunds.purchaseId,
      status: refunds.status,
      amountRefunded: refunds.amountRefunded,
      resolvedAt: refunds.resolvedAt,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, userId))
    .orderBy(desc(refunds.resolvedAt), desc(refunds.id))
    .all();

  const purchasesWithOpenRequest = new Set(
    rows.filter((row) => row.status === RefundStatus.Open).map((row) => row.purchaseId)
  );
  const seen = new Set<number>();

  return rows.filter((row) => {
    if (row.status === RefundStatus.Open) return false;
    if (purchasesWithOpenRequest.has(row.purchaseId)) return false;
    if (seen.has(row.purchaseId)) return false;
    seen.add(row.purchaseId);
    return true;
  });
}

/**
 * The email the learner gets once an admin decides. There is no mail
 * transport wired up yet, so the caller sends it to the server log.
 */
export function buildRefundDecisionEmail(
  input: DecisionSubject &
    ({ outcome: "approved"; amountRefunded: number; accessRemoved: boolean } | { outcome: "declined" })
) {
  const greeting = `Hi ${input.learner.name},`;
  const signOff = "— The Cadence team";

  if (input.outcome === "approved") {
    return {
      to: input.learner.email,
      subject: `Refund approved — ${input.course.title}`,
      body: [
        greeting,
        "",
        `We have approved your refund request for "${input.course.title}".`,
        `${formatPrice(input.amountRefunded)}, the amount you paid, is coming back to you.`,
        ...(input.accessRemoved
          ? ["", "You no longer have access to the course. If you buy it again, your progress will be waiting for you."]
          : []),
        "",
        signOff,
      ].join("\n"),
    };
  }

  return {
    to: input.learner.email,
    subject: `Refund declined — ${input.course.title}`,
    body: [
      greeting,
      "",
      `We have declined your refund request for "${input.course.title}".`,
      "You still have full access to the course.",
      "",
      signOff,
    ].join("\n"),
  };
}
