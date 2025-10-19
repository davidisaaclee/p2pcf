/**
 * Peer 2 Peer WebRTC connections with Cloudflare Workers as signalling server
 * Copyright Greg Fodor <gfodor@gmail.com>
 * Licensed under MIT
 */

import { EventEmitter } from "events";
import Peer from "tiny-simple-peer";

/**
 * Interface for storing and retrieving the context ID
 */
export interface ContextIdStore {
  /**
   * Check if a context ID is already stored
   */
  hasStoredContextId(): boolean;

  /**
   * Get the stored context ID
   * @returns The context ID or null if not stored
   */
  getContextId(): string | null;

  /**
   * Store a context ID
   * @param contextId The context ID to store
   */
  setContextId(contextId: string): void;
}

/**
 * ICE server configuration
 */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * P2PCF constructor options
 */
export interface P2PCFOptions {
  /**
   * Worker URL (optional) - if left out, will use a public worker
   */
  workerUrl?: string;

  /**
   * STUN ICE servers (optional)
   * If left out, will use public STUN from Google + Twilio
   */
  stunIceServers?: IceServer[];

  /**
   * TURN ICE servers (optional)
   * If left out, will use openrelay public TURN servers from metered.ca
   */
  turnIceServers?: IceServer[];

  /**
   * Network change poll interval (milliseconds, optional, default: 15000, 15 seconds)
   * Interval to poll STUN for network changes + reconnect
   */
  networkChangePollIntervalMs?: number;

  /**
   * State expiration interval (milliseconds, optional, default: 120000, 2 minutes)
   * Timeout interval for peers during polling
   */
  stateExpirationIntervalMs?: number;

  /**
   * State heartbeat interval (milliseconds, optional, default: 30000, 30 seconds)
   * Time before expiration to heartbeat
   */
  stateHeartbeatWindowMs?: number;

  /**
   * Fast polling duration (milliseconds, optional, default: 10000, 10 seconds)
   * How long we run fast polling after a state transition
   */
  fastPollingDurationMs?: number;

  /**
   * Fast polling rate (milliseconds, optional, default: 1500)
   * Polling rate during state transitions
   */
  fastPollingRateMs?: number;

  /**
   * Slow polling rate (milliseconds, optional, default: 5000, 5 seconds)
   * Polling rate when there has been no recent activity
   */
  slowPollingRateMs?: number;

  /**
   * Idle polling delay (milliseconds, optional, default: never)
   * How long to wait for activity before switching to idle polling rate
   */
  idlePollingAfterMs?: number;

  /**
   * Idle polling rate (milliseconds, optional, default: Infinity)
   * Polling rate when there has been no activity for idlePollingAfterMs milliseconds
   * Infinity will cause polling to stop, which is useful for idle clients left open
   */
  idlePollingRateMs?: number;

  /**
   * Options to pass to RTCPeerConnection constructor (optional)
   */
  rtcPeerConnectionOptions?: RTCConfiguration;

  /**
   * Function to customize simple-peer constructor options (optional)
   */
  customizeSimplePeerOptions?: (options: Parameters<Peer>) => Parameters<Peer>;

  /**
   * Proprietary constraints to pass to RTCPeerConnection constructor (optional)
   */
  rtcPeerConnectionProprietaryConstraints?: Record<string, unknown>;

  /**
   * SDP transform function (optional)
   * @param sdp The SDP string
   * @returns The transformed SDP string
   */
  sdpTransform?: (sdp: string) => string;

  /**
   * Custom context ID store (optional)
   * If left out, will use window.history.state storage
   */
  contextIdStore?: ContextIdStore;

  /**
   * Custom WebRTC implementation (optional)
   * If left out, will use browser's native WebRTC
   */
  wrtc?: {
    RTCPeerConnection: typeof RTCPeerConnection;
  };
}

/**
 * Event map for P2PCFPeer events (simple-peer compatible)
 */
export interface P2PCFPeerEventMap {
  connect: [];
  data: [data: ArrayBuffer];
  stream: [stream: MediaStream];
  track: [track: MediaStreamTrack, stream: MediaStream];
  close: [];
  error: [err: Error];
  signal: [data: unknown];
}

/**
 * Extended simple-peer instance with additional P2PCF fields
 */
export interface P2PCFPeer extends EventEmitter<P2PCFPeerEventMap> {
  /**
   * Per-session unique ID
   */
  id: string;

  /**
   * Client ID passed to the peer's P2PCF constructor
   */
  client_id: string;

  /**
   * Whether the peer is connected
   */
  connected: boolean;

  /**
   * Send data to the peer
   * @param data Data to send
   */
  send(data: ArrayBuffer | Uint8Array | string): void;

  /**
   * Add a media stream to the peer
   * @param stream Media stream to add
   */
  addStream(stream: MediaStream): void;

  /**
   * Add a media track to the peer
   * @param track Media track to add
   * @param stream Media stream the track belongs to
   */
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;

  /**
   * Remove a media track from the peer
   * @param track Media track to remove
   * @param stream Media stream the track belongs to
   */
  removeTrack(track: MediaStreamTrack, stream: MediaStream): void;

  /**
   * Remove a media stream from the peer
   * @param stream Media stream to remove
   */
  removeStream(stream: MediaStream): void;

  /**
   * Destroy the peer connection
   */
  destroy(): void;

  /**
   * Signal data for WebRTC negotiation
   * @param data Signal data
   */
  signal(data: unknown): void;

  /**
   * Internal peer connection (not part of public API but may be accessed)
   * @internal
   */
  _pc: RTCPeerConnection;

  /**
   * Internal ICE complete flag
   * @internal
   */
  _iceComplete?: boolean;

  /**
   * Internal pending remote SDP (used for Firefox workaround)
   * @internal
   */
  _pendingRemoteSdp?: string;
}

/**
 * Event map for P2PCF events
 */
export interface P2PCFEventMap {
  /**
   * Emitted when a new peer connects
   */
  peerconnect: [peer: P2PCFPeer];

  /**
   * Emitted when a peer disconnects
   */
  peerclose: [peer: P2PCFPeer];

  /**
   * Emitted when a message is received from a peer
   */
  msg: [peer: P2PCFPeer, data: ArrayBuffer];
}

/**
 * Main P2PCF class for WebRTC peer-to-peer connections using Cloudflare Workers
 */
export default class P2PCF extends EventEmitter<P2PCFEventMap> {
  /**
   * Map of connected peers by session ID
   */
  peers: Map<string, P2PCFPeer>;

  /**
   * Array of connected session IDs
   */
  connectedSessions: string[];

  /**
   * Client ID for this instance
   */
  clientId: string;

  /**
   * Room ID for this instance
   */
  roomId: string;

  /**
   * Session ID for this instance (unique per page load)
   */
  sessionId: string;

  /**
   * Context ID for this instance (persists across page refreshes)
   */
  contextId: string;

  /**
   * Create a new P2PCF instance
   * @param clientId Client ID (must be at least 4 characters)
   * @param roomId Room ID (must be at least 4 characters)
   * @param options Configuration options
   */
  constructor(clientId: string, roomId: string, options?: P2PCFOptions);

  /**
   * Start polling and discovering peers
   */
  start(): Promise<void>;

  /**
   * Send a message to a specific peer
   * @param peer The peer to send to
   * @param msg The message to send (ArrayBuffer or Uint8Array)
   */
  send(peer: P2PCFPeer, msg: ArrayBuffer | Uint8Array): void;

  /**
   * Broadcast a message to all connected peers
   * @param msg The message to broadcast (ArrayBuffer or Uint8Array)
   */
  broadcast(msg: ArrayBuffer | Uint8Array): void;

  /**
   * Stop polling and disconnect all peers
   */
  destroy(): void;
}
