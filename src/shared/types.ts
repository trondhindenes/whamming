/** `waiting` = needs the human; `blocked` = waiting on something else (a port, CI, another agent). */
export const STATUSES = ['waiting', 'working', 'blocked', 'idle', 'done', 'error'] as const;
export type SessionStatus = (typeof STATUSES)[number];

export type LinkKind = 'pr' | 'ticket' | 'doc' | 'other';

export interface Link {
  url: string;
  label?: string;
  kind?: LinkKind;
}

export interface ActivityEvent {
  at: string;
  status?: SessionStatus;
  message: string;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  at: string;
  read: boolean;
}

/** A subagent's work, shown as a child row under its session. */
export interface SubTask {
  /** Stable key the subagent reports under, e.g. "review-auth". */
  key: string;
  title?: string;
  status: SessionStatus;
  detail?: string;
  links: Link[];
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  /** Stable key chosen by the agent, usually its session name. */
  id: string;
  /** Display name; defaults to id. */
  name: string;
  /** Absolute path of the working folder. */
  folder: string;
  folderName: string;
  branch?: string;
  /** Free-form agent kind, e.g. "claude-code". */
  agent?: string;
  /** PID of the agent process; distinguishes two sessions claiming the same name. */
  pid?: number;
  /** Claude Code's own session UUID, if known. Guards against PID reuse. */
  claudeSessionId?: string;
  /** Where the name came from, e.g. "user" (/rename) or "derived". */
  nameSource?: string;
  status: SessionStatus;
  /** One-line "what am I working on". */
  title?: string;
  /** Longer context, e.g. current step or the question being asked. */
  detail?: string;
  links: Link[];
  /** Subagents' work (child rows). */
  tasks?: SubTask[];
  /** Who set the current status: the agent itself, or a Claude Code hook. Hooks never override the agent. */
  statusSource?: 'agent' | 'hook' | 'wait';
  /** When the current status was entered. */
  statusSince?: string;
  /** When the agent process was seen to have exited (or its conversation was replaced, e.g. /clear). */
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
  activity: ActivityEvent[];
}

/** Session as served by the API, with derived fields. */
export interface SessionView extends Omit<Session, 'activity'> {
  stale: boolean;
  /** Whether the agent process is still running (undefined when no pid was reported). */
  alive?: boolean;
  /** Ids of other live sessions claiming the same name. */
  conflicts: string[];
  /** Ports this session has claimed. */
  ports: number[];
  unread: number;
  activity?: ActivityEvent[];
}

export interface Peer {
  id: string;
  name: string;
  folder: string;
  status: SessionStatus;
  title?: string;
  branch?: string;
  pid?: number;
  relation: 'same' | 'parent' | 'child';
}

export interface PortLease {
  port: number;
  /** Session id that holds the claim. */
  session: string;
  /** Subagent task key, when a subagent holds it. */
  task?: string;
  purpose?: string;
  claimedAt: string;
  /** Registered while already in use (the agent started it before claiming). */
  adopted?: boolean;
}

export interface PortListener {
  port: number;
  pid: number;
  command: string;
  /** Session whose process tree started this listener, or whose folder owns its compose project. */
  session?: string;
  /** Docker container publishing this port. */
  container?: string;
  /** Compose project folder of that container. */
  containerFolder?: string;
}

export interface PortLeaseView extends PortLease {
  sessionName?: string;
  folder?: string;
  folderName?: string;
  sessionStatus?: SessionStatus;
  /** False when the holding session's process has exited (the claim is up for grabs). */
  ownerAlive: boolean;
  /** What is actually listening on the port right now, if anything. */
  listener?: PortListener;
}

export interface PortWaiter {
  session: string;
  task?: string;
  purpose?: string;
  since: string;
}

export interface PortQueue {
  port: number;
  /** In order: the first one gets the port next. */
  waiters: PortWaiter[];
}

export interface PortsSnapshot {
  leases: PortLeaseView[];
  /** Agents waiting for busy ports (`whamming port claim N --wait`). */
  queues: PortQueue[];
  /** Listening ports nobody has claimed. */
  unclaimed: PortListener[];
}
