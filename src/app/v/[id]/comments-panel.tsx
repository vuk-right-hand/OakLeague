'use client';

import { useState, useTransition } from 'react';
import {
  type CommentRow,
  postCommentAction,
  deleteCommentAction,
  moderateCommentAction,
  reportCommentAction,
  loadCommentsAction,
  loadRepliesAction,
} from '@/lib/video/comment-actions';

// Comments panel (COMMENTS_LIKES_PLAN C2). One level of replies. Logged-out can
// read + gets a login CTA (the draft is NEVER carried across the login hop —
// audit M5). Creator/admin see moderation controls; Delete shows only on your
// OWN comments (audit C1, via the is_own flag from the list RPCs).

type Viewer = { handle: string | null; name: string | null; avatar: string | null };

function authorLabel(c: CommentRow) {
  return c.author_name || (c.author_handle ? `@${c.author_handle}` : 'Member');
}

function CommentItem({
  c,
  videoId,
  isAuthenticated,
  isModerator,
  viewer,
  isReply = false,
  onRemoved,
}: {
  c: CommentRow;
  videoId: string;
  isAuthenticated: boolean;
  isModerator: boolean;
  viewer: Viewer;
  isReply?: boolean;
  onRemoved?: () => void;
}) {
  const [gone, setGone] = useState(false);
  const [hidden, setHidden] = useState(c.is_hidden);
  const [replies, setReplies] = useState<CommentRow[] | null>(null);
  const [replyCount, setReplyCount] = useState(c.reply_count ?? 0);
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [reported, setReported] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (gone) return null;

  const remove = () => {
    setGone(true);
    onRemoved?.();
  };

  const mod = (action: 'delete' | 'hide' | 'unhide' | 'pin' | 'unpin') =>
    start(async () => {
      const res = await moderateCommentAction({ comment_id: c.id, action });
      if (res.ok) {
        if (action === 'delete') remove();
        else if (action === 'hide') setHidden(true);
        else if (action === 'unhide') setHidden(false);
      }
    });

  return (
    <li className="oak-comment" data-hidden={hidden}>
      <div className="oak-comment-head">
        {c.author_avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="oak-comment-av" src={c.author_avatar} alt="" />
        ) : (
          <span className="oak-comment-av oak-avatar-fallback">{authorLabel(c).replace('@', '').slice(0, 1).toUpperCase()}</span>
        )}
        <span className="oak-comment-author">
          {c.author_handle ? <a href={`/@${c.author_handle}`}>{authorLabel(c)}</a> : authorLabel(c)}
        </span>
        {hidden ? <span className="oak-comment-tag">hidden</span> : null}
      </div>
      <p className="oak-comment-body">{c.body}</p>
      <div className="oak-comment-actions">
        {!isReply && isAuthenticated ? (
          <button onClick={() => setShowReply((s) => !s)} disabled={pending}>Reply</button>
        ) : null}
        {!isReply && replyCount > 0 ? (
          <button
            onClick={() => start(async () => { const r = await loadRepliesAction({ parent_id: c.id }); if (r.ok) setReplies(r.replies); })}
            disabled={pending}
          >
            {replies ? 'Replies' : `View ${replyCount} replies`}
          </button>
        ) : null}
        {/* Report: only others' comments; show feedback on failure. */}
        {isAuthenticated && !c.is_own && !reported ? (
          <button
            onClick={() => start(async () => { const r = await reportCommentAction({ comment_id: c.id }); if (r.ok) setReported(true); else setErr('Could not report.'); })}
            disabled={pending}
          >
            Report
          </button>
        ) : reported ? (
          <span className="oak-comment-tag">reported</span>
        ) : null}
        {/* Delete: ONLY your own comment (audit C1). */}
        {isAuthenticated && c.is_own ? (
          <button onClick={() => start(async () => { const r = await deleteCommentAction({ comment_id: c.id }); if (r.ok) remove(); })} disabled={pending}>
            Delete
          </button>
        ) : null}
        {isModerator ? (
          <>
            <button onClick={() => mod(hidden ? 'unhide' : 'hide')} disabled={pending}>{hidden ? 'Unhide' : 'Hide'}</button>
            {!isReply ? <button onClick={() => mod('pin')} disabled={pending}>Pin</button> : null}
            <button onClick={() => mod('delete')} disabled={pending}>Remove</button>
          </>
        ) : null}
      </div>
      {err ? <span className="oak-err" style={{ marginLeft: 36 }}>{err}</span> : null}

      {showReply ? (
        <div className="oak-comment-compose">
          <textarea value={replyText} maxLength={2000} onChange={(e) => setReplyText(e.target.value)} placeholder="Reply…" />
          <button
            className="oak-btn-primary"
            disabled={pending || replyText.trim().length === 0}
            onClick={() =>
              start(async () => {
                setErr(null);
                const body = replyText.trim();
                const res = await postCommentAction({ video_id: videoId, body, parent_id: c.id });
                if (res.ok) {
                  setReplies((r) => [
                    ...(r ?? []),
                    { id: res.id, body, author_handle: viewer.handle, author_name: viewer.name ?? 'You', author_avatar: viewer.avatar, created_at: new Date().toISOString(), is_hidden: false, is_own: true },
                  ]);
                  setReplyCount((n) => n + 1);
                  setReplyText('');
                  setShowReply(false);
                } else {
                  setErr(
                    res.error === 'rate_limited'
                      ? 'Slow down a moment.'
                      : res.error === 'link_not_allowed'
                        ? "For your safety, links aren't allowed in comments."
                        : 'Could not post.',
                  );
                }
              })
            }
          >
            Post
          </button>
        </div>
      ) : null}

      {replies && replies.length > 0 ? (
        <ul className="oak-replies">
          {replies.map((r) => (
            <CommentItem key={r.id} c={r} videoId={videoId} isAuthenticated={isAuthenticated} isModerator={isModerator} viewer={viewer} isReply />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function CommentsPanel({
  videoId,
  isAuthenticated,
  isModerator,
  initialPinned,
  initialComments,
  commentCount,
  viewerHandle,
  viewerName,
  viewerAvatar,
}: {
  videoId: string;
  isAuthenticated: boolean;
  isModerator: boolean;
  initialPinned: CommentRow[];
  initialComments: CommentRow[];
  commentCount: number;
  viewerHandle: string | null;
  viewerName: string | null;
  viewerAvatar: string | null;
}) {
  const viewer: Viewer = { handle: viewerHandle, name: viewerName, avatar: viewerAvatar };
  const [comments, setComments] = useState<CommentRow[]>(initialComments);
  const [count, setCount] = useState(commentCount);
  const [hasMore, setHasMore] = useState(initialComments.length >= 30);
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const post = () =>
    start(async () => {
      setErr(null);
      const b = body.trim();
      const res = await postCommentAction({ video_id: videoId, body: b });
      if (!res.ok) {
        setErr(
          res.error === 'rate_limited'
            ? 'Slow down a moment.'
            : res.error === 'link_not_allowed'
              ? "For your safety, links aren't allowed in comments."
              : 'Could not post.',
        );
        return;
      }
      setComments((cs) => [
        { id: res.id, body: b, author_handle: viewer.handle, author_name: viewer.name ?? 'You', author_avatar: viewer.avatar, created_at: new Date().toISOString(), is_hidden: false, reply_count: 0, is_own: true },
        ...cs,
      ]);
      setCount((n) => n + 1);
      setBody('');
    });

  const loadMore = () =>
    start(async () => {
      const last = comments[comments.length - 1];
      const res = await loadCommentsAction({ video_id: videoId, cursor_ts: last?.created_at, cursor_id: last?.id });
      if (res.ok) {
        setComments((cs) => [...cs, ...res.comments]);
        setHasMore(res.comments.length >= 30); // short page → no more (audit M2)
      }
    });

  return (
    <section className="oak-comments" aria-label="Comments">
      <h2 className="oak-comments-title">{count} comments</h2>

      {isAuthenticated ? (
        <div className="oak-comment-compose">
          <textarea value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment…" />
          {err ? <span className="oak-err">{err}</span> : null}
          <button className="oak-btn-primary" onClick={post} disabled={pending || body.trim().length === 0}>Post</button>
        </div>
      ) : (
        <a className="oak-btn-secondary" href={`/login?next=${encodeURIComponent(`/v/${videoId}`)}`}>Log in to comment</a>
      )}

      <ul className="oak-comment-list">
        {initialPinned.map((c) => (
          <li key={c.id} className="oak-pinned">
            <span className="oak-comment-tag">📌 pinned</span>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              <CommentItem c={c} videoId={videoId} isAuthenticated={isAuthenticated} isModerator={isModerator} viewer={viewer} />
            </ul>
          </li>
        ))}
        {comments.map((c) => (
          <CommentItem
            key={c.id}
            c={c}
            videoId={videoId}
            isAuthenticated={isAuthenticated}
            isModerator={isModerator}
            viewer={viewer}
            onRemoved={() => setCount((n) => Math.max(0, n - 1))}
          />
        ))}
      </ul>

      {hasMore ? (
        <button className="oak-btn-secondary" onClick={loadMore} disabled={pending}>Load more</button>
      ) : null}
    </section>
  );
}
