// PROTOTYPE: throwaway UI prototype for "What do Notifications look like in Cadence?"
// Lives on the `notif-proto` branch only; never merge to main.
//
// Plan: four variants of in-app Notifications, mounted in the real app shell
// (sidebar + every page), switchable via `?variant=A|B|C|D` and the floating
// bottom bar. Data is fake and in memory (the eight v1 Notifications from the
// wayfinder ticket), chosen by the current DevUI user's role. Reload to reset.
//
//   A  Bell + popover       : bell in the sidebar brand row, dropdown list
//   B  Nav item + side panel : "Notifications" nav entry, full-height panel
//   C  Inbox page            : "Inbox" nav entry, three-pane page in <main>
//   D  Sidebar digest        : always-visible section listing what's new
//
// `?empty=1` shows the empty state. Opening a feed fakes a 600ms load.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Popover, Dialog } from "radix-ui";
import {
  Bell,
  BellOff,
  BookOpen,
  Check,
  CheckCheck,
  CircleCheck,
  CircleX,
  Inbox,
  MessageSquare,
  Receipt,
  Reply,
  UserCog,
  UsersRound,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserRole } from "~/db/schema";
import { Skeleton } from "~/components/ui/skeleton";
import { UserAvatar } from "~/components/user-avatar";
import {
  PrototypeSwitcher,
  usePrototypeVariant,
  type PrototypeVariant,
} from "~/components/prototype-switcher";

// ---------------------------------------------------------------------------
// Fake data: the eight v1 Notifications
// ---------------------------------------------------------------------------

type Kind =
  | "refund-raised"
  | "refund-approved"
  | "refund-declined"
  | "new-question"
  | "new-reply"
  | "seat-claimed"
  | "course-status"
  | "role-changed";

interface Notif {
  id: string;
  kind: Kind;
  actor: string | null;
  text: React.ReactNode;
  course: string | null;
  // Real links for New Question / New Reply go to the lesson at that Question;
  // lesson pages have no per-Question anchors yet, so the prototype uses the
  // course page.
  href: string;
  minutesAgo: number;
  read: boolean;
}

const B = ({ children }: { children: React.ReactNode }) => (
  <span className="font-semibold text-foreground">{children}</span>
);

const TS = "Introduction to TypeScript";
const NODE = "Building REST APIs with Node.js";
const DS = "Design Systems with Tailwind";

function seedFor(role: UserRole | null, isTeamAdmin: boolean): Notif[] {
  if (!role) return [];
  if (role === UserRole.Admin) {
    return [
      { id: "a1", kind: "refund-raised", actor: "Emma Wilson", course: TS, href: "/admin/refunds", minutesAgo: 6, read: false,
        text: <><B>Emma Wilson</B> asked for a refund on <B>{TS}</B></> },
      { id: "a2", kind: "refund-raised", actor: "Liam Thompson", course: DS, href: "/admin/refunds", minutesAgo: 95, read: false,
        text: <><B>Liam Thompson</B> asked for a refund on <B>{DS}</B></> },
      { id: "a3", kind: "new-reply", actor: "Sarah Chen", course: TS, href: "/courses/introduction-to-typescript", minutesAgo: 26 * 60, read: true,
        text: <><B>Sarah Chen</B> replied to a question you replied to on <B>Function Types</B></> },
      { id: "a4", kind: "refund-raised", actor: "James Park", course: NODE, href: "/admin/refunds", minutesAgo: 3 * 1440, read: true,
        text: <><B>James Park</B> asked for a refund on <B>{NODE}</B></> },
      { id: "a5", kind: "role-changed", actor: null, course: null, href: "/dashboard", minutesAgo: 9 * 1440, read: true,
        text: <>You're now <B>a Platform Admin</B> on Cadence</> },
    ];
  }
  if (role === UserRole.Instructor) {
    return [
      { id: "i1", kind: "new-question", actor: "James Park", course: TS, href: "/courses/introduction-to-typescript", minutesAgo: 12, read: false,
        text: <><B>James Park</B> asked a question on <B>Primitive Types</B> in <B>{TS}</B></> },
      { id: "i2", kind: "new-reply", actor: "Olivia Martinez", course: TS, href: "/courses/introduction-to-typescript", minutesAgo: 50, read: false,
        text: <><B>Olivia Martinez</B> replied to a question you replied to on <B>Function Types</B></> },
      { id: "i3", kind: "new-question", actor: "Sophia Davis", course: TS, href: "/courses/introduction-to-typescript", minutesAgo: 5 * 60, read: false,
        text: <><B>Sophia Davis</B> asked a question on <B>Arrays and Tuples</B> in <B>{TS}</B></> },
      { id: "i4", kind: "course-status", actor: null, course: NODE, href: "/instructor", minutesAgo: 1440 + 120, read: false,
        text: <>A Platform Admin <B>archived</B> <B>{NODE}</B></> },
      { id: "i5", kind: "course-status", actor: null, course: TS, href: "/instructor", minutesAgo: 4 * 1440, read: true,
        text: <>A Platform Admin <B>published</B> <B>{TS}</B></> },
      { id: "i6", kind: "role-changed", actor: null, course: null, href: "/dashboard", minutesAgo: 20 * 1440, read: true,
        text: <>You're now <B>an Instructor</B> on Cadence</> },
    ];
  }
  const student: Notif[] = [
    { id: "s1", kind: "new-reply", actor: "Sarah Chen", course: TS, href: "/courses/introduction-to-typescript", minutesAgo: 18, read: false,
      text: <><B>Sarah Chen</B> replied to your question on <B>Primitive Types</B></> },
    { id: "s2", kind: "refund-declined", actor: null, course: DS, href: "/settings", minutesAgo: 1440 + 30, read: false,
      text: <>Your refund request for <B>{DS}</B> was declined</> },
    { id: "s3", kind: "new-reply", actor: "James Park", course: TS, href: "/courses/introduction-to-typescript", minutesAgo: 2 * 1440, read: true,
      text: <><B>James Park</B> replied to a question you replied to on <B>Function Types</B></> },
    { id: "s4", kind: "refund-approved", actor: null, course: NODE, href: "/settings", minutesAgo: 8 * 1440, read: true,
      text: <>Your refund request for <B>{NODE}</B> was approved</> },
  ];
  if (!isTeamAdmin) return student;
  const teamAdmin: Notif[] = [
    { id: "t1", kind: "seat-claimed", actor: "Olivia Martinez", course: TS, href: "/team", minutesAgo: 35, read: false,
      text: <><B>Olivia Martinez</B> claimed a seat on <B>{TS}</B> (4 of 10 claimed)</> },
    { id: "t2", kind: "seat-claimed", actor: "Liam Thompson", course: TS, href: "/team", minutesAgo: 3 * 60, read: false,
      text: <><B>Liam Thompson</B> claimed a seat on <B>{TS}</B> (3 of 10 claimed)</> },
    ...student,
    { id: "t3", kind: "seat-claimed", actor: "Emma Wilson", course: TS, href: "/team", minutesAgo: 6 * 1440, read: true,
      text: <><B>Emma Wilson</B> claimed a seat on <B>{TS}</B> (2 of 10 claimed)</> },
  ];
  return teamAdmin.sort((a, b) => a.minutesAgo - b.minutesAgo);
}

// ---------------------------------------------------------------------------
// Shared helpers (icons and time only; each variant owns its own layout)
// ---------------------------------------------------------------------------

const KIND_META: Record<Kind, { icon: React.ElementType; tint: string; cta: string; category: string }> = {
  "refund-raised": { icon: Receipt, tint: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300", cta: "Review refund requests", category: "Refunds" },
  "refund-approved": { icon: CircleCheck, tint: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", cta: "See your refund requests", category: "Refunds" },
  "refund-declined": { icon: CircleX, tint: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300", cta: "See your refund requests", category: "Refunds" },
  "new-question": { icon: MessageSquare, tint: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300", cta: "Go to the question", category: "Questions" },
  "new-reply": { icon: Reply, tint: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300", cta: "Go to the question", category: "Questions" },
  "seat-claimed": { icon: UsersRound, tint: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300", cta: "Manage your team", category: "Team" },
  "course-status": { icon: BookOpen, tint: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300", cta: "Open your courses", category: "Courses" },
  "role-changed": { icon: UserCog, tint: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300", cta: "Go to your dashboard", category: "Account" },
};

function KindIcon({ kind, className }: { kind: Kind; className?: string }) {
  const { icon: Icon, tint } = KIND_META[kind];
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", tint, className)}>
      <Icon className="size-4" />
    </span>
  );
}

function ago(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

function agoLong(min: number): string {
  if (min < 60) return `${min} minutes ago`;
  if (min < 1440) return `${Math.floor(min / 60)} hours ago`;
  const d = Math.floor(min / 1440);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function countLabel(n: number) {
  return n > 9 ? "9+" : String(n);
}

function useFakeLoading(active: boolean) {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    const t = setTimeout(() => setLoading(false), 600);
    return () => clearTimeout(t);
  }, [active]);
  return loading;
}

// ---------------------------------------------------------------------------
// In-memory store + variant
// ---------------------------------------------------------------------------

const VARIANTS: PrototypeVariant[] = [
  { key: "A", name: "Bell + popover" },
  { key: "B", name: "Nav item + side panel" },
  { key: "C", name: "Inbox page" },
  { key: "D", name: "Sidebar digest" },
];

interface Store {
  variant: string;
  signedIn: boolean;
  items: Notif[];
  unread: number;
  roleLabel: string;
  markRead: (id: string) => void;
  markUnread: (id: string) => void;
  markAllRead: () => void;
}

const Ctx = createContext<Store | null>(null);

function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("NotificationsPrototypeProvider missing");
  return s;
}

export function NotificationsPrototypeProvider({
  role,
  isTeamAdmin,
  children,
}: {
  role: UserRole | null;
  isTeamAdmin: boolean;
  children: React.ReactNode;
}) {
  const variant = usePrototypeVariant(VARIANTS);
  const [params, setParams] = useSearchParams();
  const empty = params.get("empty") === "1";
  const [all, setAll] = useState(() => seedFor(role, isTeamAdmin));
  const items = empty ? [] : all;
  const unread = items.filter((n) => !n.read).length;

  const roleLabel = !role
    ? "signed out"
    : role === UserRole.Admin
      ? "Platform Admin"
      : role === UserRole.Instructor
        ? "Instructor"
        : isTeamAdmin
          ? "Student + Team Admin"
          : "Student";

  const store: Store = {
    variant,
    signedIn: role !== null,
    items,
    unread,
    roleLabel,
    markRead: (id) => setAll((xs) => xs.map((n) => (n.id === id ? { ...n, read: true } : n))),
    markUnread: (id) => setAll((xs) => xs.map((n) => (n.id === id ? { ...n, read: false } : n))),
    markAllRead: () => setAll((xs) => xs.map((n) => ({ ...n, read: true }))),
  };

  function toggleEmpty() {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (empty) p.delete("empty");
        else p.set("empty", "1");
        return p;
      },
      { replace: true, preventScrollReset: true }
    );
  }

  return (
    <Ctx.Provider value={store}>
      {children}
      <PrototypeSwitcher variants={VARIANTS} current={variant}>
        <span>{roleLabel}</span>
        <span>·</span>
        <span>
          {unread} unread / {items.length}
        </span>
        <button
          onClick={toggleEmpty}
          className={cn("rounded-full px-2 py-0.5", empty ? "bg-white text-fuchsia-700" : "bg-white/20 hover:bg-white/30")}
        >
          empty {empty ? "on" : "off"}
        </button>
      </PrototypeSwitcher>
    </Ctx.Provider>
  );
}

function useOpen() {
  const navigate = useNavigate();
  const { markRead } = useStore();
  return (n: Notif) => {
    markRead(n.id);
    navigate(n.href);
  };
}

function EmptyState({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center text-muted-foreground", compact ? "gap-1 py-4" : "gap-2 py-12")}>
      <BellOff className={compact ? "size-4" : "size-8"} />
      <div className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>You're all caught up</div>
      {!compact && (
        <div className="max-w-56 text-xs">
          Notifications about your courses, questions and requests will show up here.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant A: bell in the brand row + popover
// ---------------------------------------------------------------------------

export function PrototypeBrandRowBell() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const loading = useFakeLoading(open);
  const openItem = useOpen();
  if (s.variant !== "A" || !s.signedIn) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="relative rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent"
          title="Notifications"
        >
          <Bell className="size-5" />
          {s.unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
              {countLabel(s.unread)}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={12}
          className="z-50 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="text-sm font-semibold">Notifications</div>
            <button
              onClick={s.markAllRead}
              disabled={s.unread === 0}
              className="text-xs font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-40"
            >
              Mark all as read
            </button>
          </div>
          <div className="max-h-[28rem] overflow-y-auto">
            {loading ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="size-8 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : s.items.length === 0 ? (
              <EmptyState />
            ) : (
              s.items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    openItem(n);
                  }}
                  className={cn(
                    "flex w-full items-start gap-3 border-b px-4 py-3 text-left text-sm text-muted-foreground transition-colors last:border-b-0 hover:bg-accent",
                    !n.read && "bg-primary/5"
                  )}
                >
                  <KindIcon kind={n.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="leading-snug">{n.text}</div>
                    <div className="mt-1 text-xs">{agoLong(n.minutesAgo)}</div>
                  </div>
                  {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-600" />}
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Variant B: "Notifications" nav item + full-height side panel
// ---------------------------------------------------------------------------

const navItemClass =
  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors";
const navIdle =
  "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
const navActive = "bg-sidebar-accent text-sidebar-accent-foreground";

function groupByAge(items: Notif[]) {
  const groups: { label: string; items: Notif[] }[] = [
    { label: "Today", items: [] },
    { label: "This week", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const n of items) {
    const g = n.minutesAgo < 1440 ? 0 : n.minutesAgo < 7 * 1440 ? 1 : 2;
    groups[g].items.push(n);
  }
  return groups.filter((g) => g.items.length > 0);
}

function PanelNavItem() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const loading = useFakeLoading(open);
  const openItem = useOpen();
  const shown = tab === "unread" ? s.items.filter((n) => !n.read) : s.items;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={cn(navItemClass, open ? navActive : navIdle)}>
          <Bell className="size-4" />
          Notifications
          {s.unread > 0 && (
            <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary-foreground">
              {s.unread}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-y-0 left-56 right-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 left-56 z-50 flex w-[26rem] flex-col border-r bg-background shadow-2xl outline-none">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <Dialog.Title className="text-base font-semibold">Notifications</Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-muted-foreground hover:bg-accent">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex items-center justify-between border-b px-5 py-2">
            <div className="flex gap-1 rounded-md bg-muted p-0.5 text-xs font-medium">
              {(["all", "unread"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn("rounded px-3 py-1 capitalize", tab === t ? "bg-background shadow-sm" : "text-muted-foreground")}
                >
                  {t}
                  {t === "unread" && s.unread > 0 ? ` (${s.unread})` : ""}
                </button>
              ))}
            </div>
            <button
              onClick={s.markAllRead}
              disabled={s.unread === 0}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="space-y-4 p-5">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : shown.length === 0 ? (
              <EmptyState />
            ) : (
              groupByAge(shown).map((g) => (
                <div key={g.label}>
                  <div className="sticky top-0 bg-background/95 px-5 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                    {g.label}
                  </div>
                  {g.items.map((n) => (
                    <div
                      key={n.id}
                      className={cn("group relative mx-2 flex gap-3 rounded-lg px-3 py-3 hover:bg-accent", !n.read && "bg-primary/5")}
                    >
                      {!n.read && <span className="absolute left-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-blue-600" />}
                      {n.actor ? (
                        <UserAvatar name={n.actor} avatarUrl={null} className="size-9" />
                      ) : (
                        <KindIcon kind={n.kind} className="size-9" />
                      )}
                      <button
                        onClick={() => {
                          setOpen(false);
                          openItem(n);
                        }}
                        className="min-w-0 flex-1 text-left text-sm text-muted-foreground"
                      >
                        <div className="leading-snug">{n.text}</div>
                        <div className="mt-1.5 flex items-center gap-2 text-xs">
                          {n.course && (
                            <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px]">{n.course}</span>
                          )}
                          <span className="shrink-0">{ago(n.minutesAgo)}</span>
                        </div>
                      </button>
                      <button
                        onClick={() => (n.read ? s.markUnread(n.id) : s.markRead(n.id))}
                        title={n.read ? "Mark as unread" : "Mark as read"}
                        className="invisible self-start rounded p-1 text-muted-foreground hover:bg-background group-hover:visible"
                      >
                        <Check className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Variant C: "Inbox" nav item + three-pane page rendered in <main>
// ---------------------------------------------------------------------------

function InboxNavItem() {
  const s = useStore();
  const [params, setParams] = useSearchParams();
  const active = params.get("inbox") === "1";
  return (
    <button
      onClick={() =>
        setParams((prev) => {
          const p = new URLSearchParams(prev);
          p.set("inbox", "1");
          return p;
        })
      }
      className={cn(navItemClass, active ? navActive : navIdle)}
    >
      <Inbox className="size-4" />
      Inbox
      {s.unread > 0 && (
        <span className="ml-auto text-xs font-semibold text-sidebar-foreground">{s.unread}</span>
      )}
    </button>
  );
}

function InboxPage() {
  const s = useStore();
  const navigate = useNavigate();
  const loading = useFakeLoading(true);
  const [category, setCategory] = useState("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const categories = useMemo(() => {
    const names = ["All", ...new Set(s.items.map((n) => KIND_META[n.kind].category))];
    return names.map((name) => ({
      name,
      unread: s.items.filter((n) => !n.read && (name === "All" || KIND_META[n.kind].category === name)).length,
    }));
  }, [s.items]);

  const shown = s.items.filter((n) => category === "All" || KIND_META[n.kind].category === category);
  const selected = shown.find((n) => n.id === selectedId) ?? null;

  function select(n: Notif) {
    setSelectedId(n.id);
    s.markRead(n.id);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            {s.unread > 0 ? `${s.unread} unread` : "Nothing unread"}
          </p>
        </div>
        <button
          onClick={s.markAllRead}
          disabled={s.unread === 0}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-40"
        >
          <CheckCheck className="size-4" /> Mark all as read
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[11rem_minmax(0,1fr)_minmax(0,1.1fr)]">
        <nav className="space-y-0.5 border-r p-3">
          {categories.map((c) => (
            <button
              key={c.name}
              onClick={() => {
                setCategory(c.name);
                setSelectedId(null);
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-3 py-1.5 text-sm",
                category === c.name ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60"
              )}
            >
              {c.name}
              {c.unread > 0 && <span className="text-xs font-semibold text-foreground">{c.unread}</span>}
            </button>
          ))}
        </nav>
        <div className="overflow-y-auto border-r">
          {loading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <EmptyState />
          ) : (
            shown.map((n) => (
              <button
                key={n.id}
                onClick={() => select(n)}
                className={cn(
                  "flex w-full items-center gap-3 border-b px-4 py-2.5 text-left text-sm",
                  selected?.id === n.id ? "bg-accent" : "hover:bg-accent/50",
                  n.read ? "text-muted-foreground [&_span]:font-normal" : "text-foreground"
                )}
              >
                <span className={cn("size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-blue-600")} />
                <div className="min-w-0 flex-1 truncate">{n.text}</div>
                <span className="shrink-0 text-xs text-muted-foreground">{ago(n.minutesAgo)}</span>
              </button>
            ))
          )}
        </div>
        <div className="overflow-y-auto p-8">
          {selected ? (
            <div className="max-w-md space-y-5">
              <KindIcon kind={selected.kind} className="size-12 [&_svg]:size-6" />
              <div className="text-lg leading-snug text-muted-foreground">{selected.text}</div>
              <div className="space-y-1 text-sm text-muted-foreground">
                {selected.course && <div>Course: {selected.course}</div>}
                <div>{agoLong(selected.minutesAgo)}</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => navigate(selected.href)}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {KIND_META[selected.kind].cta}
                </button>
                <button
                  onClick={() => s.markUnread(selected.id)}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                >
                  Mark as unread
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a notification to see it here
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Wraps <Outlet/>: in variant C with `?inbox=1`, shows the inbox instead. */
export function PrototypeMain({ children }: { children: React.ReactNode }) {
  const s = useStore();
  const [params] = useSearchParams();
  if (s.variant === "C" && s.signedIn && params.get("inbox") === "1") return <InboxPage />;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Variant D: always-visible digest section in the sidebar
// ---------------------------------------------------------------------------

export function PrototypeSidebarDigest() {
  const s = useStore();
  const [expanded, setExpanded] = useState(false);
  const openItem = useOpen();
  if (s.variant !== "D" || !s.signedIn) return null;

  const unreadItems = s.items.filter((n) => !n.read);
  const readItems = s.items.filter((n) => n.read);
  const visibleUnread = expanded ? unreadItems : unreadItems.slice(0, 3);
  const hidden = unreadItems.length - visibleUnread.length + (expanded ? 0 : readItems.length);

  return (
    <div className="border-t border-sidebar-border p-3">
      <div className="mb-2 flex items-center justify-between px-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
          What's new{s.unread > 0 && <span className="ml-1.5 text-sidebar-foreground">{s.unread}</span>}
        </div>
        {s.unread > 0 && (
          <button onClick={s.markAllRead} className="text-[11px] text-sidebar-foreground/50 hover:text-sidebar-foreground">
            Clear
          </button>
        )}
      </div>
      <div className={cn("space-y-0.5", expanded && "max-h-72 overflow-y-auto")}>
        {s.items.length === 0 || (unreadItems.length === 0 && !expanded) ? (
          <div className="px-3 py-1 text-xs text-sidebar-foreground/50">Nothing new</div>
        ) : null}
        {[...visibleUnread, ...(expanded ? readItems : [])].map((n) => (
          <button
            key={n.id}
            onClick={() => openItem(n)}
            className={cn(
              "block w-full rounded-md px-3 py-1.5 text-left text-xs leading-snug transition-colors hover:bg-sidebar-accent",
              n.read ? "text-sidebar-foreground/50 [&_span]:font-normal [&_span]:text-sidebar-foreground/60" : "text-sidebar-foreground/80"
            )}
          >
            <span className="line-clamp-2">{n.text}</span>
            <span className="mt-0.5 block text-[10px] text-sidebar-foreground/40">{ago(n.minutesAgo)} ago</span>
          </button>
        ))}
      </div>
      {s.items.length > 0 && (hidden > 0 || expanded) && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 px-3 text-[11px] font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground"
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav slot for B and C
// ---------------------------------------------------------------------------

export function PrototypeNavItem() {
  const s = useStore();
  if (!s.signedIn) return null;
  if (s.variant === "B") return <PanelNavItem />;
  if (s.variant === "C") return <InboxNavItem />;
  return null;
}
