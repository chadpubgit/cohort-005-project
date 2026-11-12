import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AlertTriangle, ReceiptText } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { db } from "~/db";
import { UserRole, users } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  buildRefundDecisionEmail,
  declineRefundRequest,
  listOpenRefundRequests,
  type OpenRefundRequest,
} from "~/lib/refunds.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

const refundDecisionSchema = z.object({
  intent: z.enum(["approve", "decline"]),
  refundRequestId: z.coerce.number().int(),
});

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refund requests.", {
      status: 401,
    });
  }

  const currentUser = db.select().from(users).where(eq(users.id, currentUserId)).get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can review refund requests.", { status: 403 });
  }

  return currentUser;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline open refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  return { refundRequests: listOpenRefundRequests(db) };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundDecisionSchema);

  if (!parsed.success) {
    throw data("Invalid refund decision.", { status: 400 });
  }

  const { intent, refundRequestId } = parsed.data;
  const input = { refundRequestId, adminUserId: admin.id };
  const result =
    intent === "approve"
      ? approveRefundRequest(db, input)
      : declineRefundRequest(db, input);

  if (result.outcome === "not-found") {
    throw data("Refund request not found.", { status: 404 });
  }

  if (result.outcome === "already-decided") {
    throw data("This refund request has already been decided.", {
      status: 409,
    });
  }

  const email = buildRefundDecisionEmail(result);
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { success: true, outcome: result.outcome };
}

function formatWatchTime(seconds: number) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
      {children}
    </span>
  );
}

function DecisionButtons({ refundRequest }: { refundRequest: OpenRefundRequest }) {
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      toast.success(
        fetcher.data.outcome === "approved"
          ? "Refund request approved."
          : "Refund request declined."
      );
    }
  }, [fetcher.state, fetcher.data]);

  const busy = fetcher.state !== "idle";

  if (confirming) {
    const prompt =
      confirming === "approve"
        ? `Refund ${formatPrice(refundRequest.amountPaid)} and remove ${refundRequest.learner.name}'s access?`
        : `Decline ${refundRequest.learner.name}'s request?`;

    return (
      <div className="flex flex-col items-start gap-2">
        <span className="text-xs text-muted-foreground">
          {prompt} This can't be undone.
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant={confirming === "approve" ? "default" : "destructive"}
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => {
              fetcher.submit(
                { intent: confirming, refundRequestId: String(refundRequest.id) },
                { method: "post" }
              );
              setConfirming(null);
            }}
          >
            Confirm
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setConfirming(null)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() => setConfirming("approve")}
      >
        Approve
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() => setConfirming("decline")}
      >
        Decline
      </Button>
    </div>
  );
}

function RefundRequestRow({ refundRequest }: { refundRequest: OpenRefundRequest }) {
  const { flags } = refundRequest;
  const hasFlags = flags.watchedOverLimit || flags.completedOverLimit || flags.seatClaimed;

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3">
        <div className="text-sm font-medium">{refundRequest.learner.name}</div>
        <div className="text-xs text-muted-foreground">{refundRequest.learner.email}</div>
      </td>
      <td className="px-4 py-3">
        <Link
          to={`/courses/${refundRequest.course.slug}`}
          className="text-sm font-medium hover:underline"
        >
          {refundRequest.course.title}
        </Link>
        <div className="text-xs text-muted-foreground">
          {formatPrice(refundRequest.amountPaid)} · bought {formatDate(refundRequest.purchasedAt)}
        </div>
      </td>
      <td className="px-4 py-3 text-sm">
        <div>
          {refundRequest.completedLessons} / {refundRequest.totalLessons} lessons (
          {refundRequest.completionPercent}%)
        </div>
        <div className="text-xs text-muted-foreground">
          {formatWatchTime(refundRequest.watchedSeconds)} watched
        </div>
        {hasFlags && (
          <div className="mt-2 flex flex-wrap gap-1">
            {flags.watchedOverLimit && <Flag>Watched over 2h</Flag>}
            {flags.completedOverLimit && <Flag>Over 50% complete</Flag>}
            {flags.seatClaimed && <Flag>Seat claimed</Flag>}
          </div>
        )}
      </td>
      <td className="max-w-xs px-4 py-3">
        <p className="text-sm">{refundRequest.reason}</p>
        <div className="mt-1 text-xs text-muted-foreground">
          Asked {formatDate(refundRequest.requestedAt)}
        </div>
      </td>
      <td className="px-4 py-3">
        <DecisionButtons refundRequest={refundRequest} />
      </td>
    </tr>
  );
}

const headings = ["Learner", "Course", "Progress", "Reason", "Decision"];

function TableHead() {
  return (
    <thead>
      <tr className="border-b border-border bg-muted/50">
        {headings.map((heading) => (
          <th
            key={heading}
            className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            {heading}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="mt-2 h-5 w-80" />
      </div>
      <Skeleton className="mb-4 h-5 w-28" />
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <TableHead />
              <tbody>
                {Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {headings.map((heading) => (
                      <td key={heading} className="px-4 py-3">
                        <Skeleton className="h-4 w-28" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline open refund requests, oldest first
        </p>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <ReceiptText className="size-4" />
        <span>
          {refundRequests.length} open{" "}
          {refundRequests.length === 1 ? "request" : "requests"}
        </span>
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">No open Refund Requests.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <TableHead />
                <tbody>
                  {refundRequests.map((refundRequest) => (
                    <RefundRequestRow key={refundRequest.id} refundRequest={refundRequest} />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button variant="outline">Go Home</Button>
          </Link>
          <Link to="/admin/refunds">
            <Button>Back to Refund Requests</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
