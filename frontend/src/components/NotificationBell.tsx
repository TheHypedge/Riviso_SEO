"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api, NotificationPublic } from "@/lib/api";
import styles from "./NotificationBell.module.css";

function timeAgo(iso: string): string {
  if (!iso) return "";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch {
    return "";
  }
}

function notificationLink(n: NotificationPublic): string | null {
  const d = n.data || {};
  if (
    n.type === "invitation_received" ||
    n.type === "invitation_cancelled" ||
    n.type === "invitation_accepted" ||
    n.type === "invitation_declined"
  ) {
    return "/invitations";
  }
  if (d.project_id && typeof d.project_id === "string") {
    return `/projects/${d.project_id}`;
  }
  return null;
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [notifications, setNotifications] = useState<NotificationPublic[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const fetchCount = useCallback(async () => {
    try {
      const r = await api.getUnreadNotificationCount();
      setUnread(r.count);
    } catch {}
  }, []);

  useEffect(() => {
    void fetchCount();
    const id = setInterval(() => void fetchCount(), 30000);
    return () => clearInterval(id);
  }, [fetchCount]);

  const openPanel = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setLoading(true);
    try {
      const data = await api.getNotifications();
      setNotifications(data.slice(0, 20));
    } catch {}
    setLoading(false);
  };

  const handleMarkAllRead = async () => {
    try {
      await api.markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnread(0);
    } catch {}
  };

  const handleNotifClick = async (n: NotificationPublic) => {
    if (!n.read) {
      try {
        await api.markNotificationRead(n.id);
        setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
        setUnread(prev => Math.max(0, prev - 1));
      } catch {}
    }
    const link = notificationLink(n);
    if (link) {
      setOpen(false);
      router.push(link);
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className={styles.wrap}>
      <button
        ref={btnRef}
        type="button"
        className={styles.bell}
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        aria-haspopup="true"
        aria-expanded={open ? "true" : "false"}
        onClick={() => void openPanel()}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M10 2a6 6 0 0 0-6 6v3l-1.5 2.5A1 1 0 0 0 3.5 15h13a1 1 0 0 0 .86-1.5L16 11V8a6 6 0 0 0-6-6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M8 15a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        {unread > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className={styles.panel} role="dialog" aria-label="Notifications">
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Notifications</span>
            {unread > 0 && (
              <button type="button" className={styles.markAllBtn} onClick={() => void handleMarkAllRead()}>
                Mark all read
              </button>
            )}
          </div>

          <div className={styles.list}>
            {loading && (
              <div className={styles.emptyState}>Loading…</div>
            )}
            {!loading && notifications.length === 0 && (
              <div className={styles.emptyState}>No notifications yet</div>
            )}
            {!loading && notifications.map(n => {
              const link = notificationLink(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`${styles.item} ${n.read ? styles.itemRead : styles.itemUnread}`}
                  onClick={() => void handleNotifClick(n)}
                  title={link ? "Click to view" : undefined}
                >
                  <div className={styles.itemDot} aria-hidden="true" data-unread={n.read ? "false" : "true"} />
                  <div className={styles.itemBody}>
                    <div className={styles.itemTitle}>{n.title}</div>
                    <div className={styles.itemMeta}>{n.body}</div>
                    <div className={styles.itemTime}>{timeAgo(n.created_at)}</div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className={styles.panelFooter}>
            <button
              type="button"
              className={styles.viewAllBtn}
              onClick={() => { setOpen(false); router.push("/invitations"); }}
            >
              View all invitations →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
