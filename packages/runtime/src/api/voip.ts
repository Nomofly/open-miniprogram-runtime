/**
 * Real-time voice and video chat: `wx.joinVoIPChat` and the APIs around it,
 * and the `<voip-room>` windows that show the members of a video room.
 *
 * The simulator has no network to call over. Joining a room puts the user in
 * it with the members `config.voip.members` names, holds the microphone (and
 * the camera in a video room) in the capsule, and has the other members take
 * turns speaking. Going to the background interrupts the chat, as WeChat does.
 */
import { asyncApi, safeCall, ApiError, type AnyFunction, type Options } from "./common.ts";
import type { ApiContext } from "./context.ts";
import { requireParam, withErrCode } from "./device.ts";

/** The members already in every room, when `config.voip.members` names none. */
const DEFAULT_MEMBERS = ["omr-openid-voip-member"];
/** How long each member speaks before the next one does. */
const SPEAKER_MS = 3000;
/** Without subscribing, a video room shows the first two members who joined. */
const SHOWN_WITHOUT_SUBSCRIBING = 2;

type Listener = AnyFunction;

interface Room {
  roomType: "voice" | "video";
  members: string[];
  muteMicrophone: boolean;
  muteEarphone: boolean;
  /** Members whose video `subscribeVoIPVideoMembers` asked for. */
  subscribed?: string[];
  release: () => void;
  speaker?: ReturnType<typeof setInterval>;
}

/** A `<voip-room>` on a page, by `webviewId:roomId`. */
interface VoipWindow {
  webviewId: number;
  roomId: number;
  openid: string;
  mode: string;
}

export function createVoipApis(ctx: ApiContext, selfOpenId: string) {
  const { host } = ctx;
  let room: Room | undefined;
  let joining = false;
  const windows = new Map<string, VoipWindow>();

  const listeners = (name: string) => {
    const set = new Set<Listener>();
    return {
      on: (listener: Listener) => {
        if (typeof listener === "function") set.add(listener);
      },
      off: (listener?: Listener) => {
        if (typeof listener === "function") set.delete(listener);
        else set.clear();
      },
      emit: (result: Record<string, unknown>) =>
        set.forEach((listener) =>
          safeCall(listener, { errCode: 0, errMsg: `${name}:ok`, ...result }),
        ),
    };
  };
  const membersChanged = listeners("onVoIPChatMembersChanged");
  const speakersChanged = listeners("onVoIPChatSpeakersChanged");
  const interrupted = listeners("onVoIPChatInterrupted");
  const stateChanged = listeners("onVoIPChatStateChanged");
  const videoMembersChanged = listeners("onVoIPVideoMembersChanged");

  /** What a `<voip-room>` shows: a failure, or whether its member's video is shown and the user's microphone is muted. */
  const windowState = ({ openid, mode }: VoipWindow) => {
    if (!room) return { error: "not in a VoIP chat" };
    if (room.roomType !== "video") return { error: "the VoIP chat is not a video room" };
    if (mode === "camera" && openid !== selfOpenId) {
      return { error: 'mode "camera" is for the user\'s own openid' };
    }
    const index = room.members.indexOf(openid);
    if (index < 0) return { error: `openid ${openid} is not in the VoIP chat` };
    const visible =
      openid === selfOpenId ||
      (room.subscribed
        ? room.subscribed.includes(openid)
        : index < SHOWN_WITHOUT_SUBSCRIBING || room.members.length <= SHOWN_WITHOUT_SUBSCRIBING);
    return { visible, muted: openid === selfOpenId && room.muteMicrophone };
  };
  /** `created` when the window was just inserted: only then does a failure fire `error`. */
  const tellWindow = (entry: VoipWindow, created = false) => {
    const { error, ...state } = windowState(entry);
    host.sendView(entry.webviewId, {
      type: "voipRoomState",
      roomId: entry.roomId,
      ...(error === undefined ? state : { error: `insertVoIPRoom:fail ${error}`, fire: created }),
    });
  };
  const tellWindows = () => windows.forEach((entry) => tellWindow(entry));

  /** A `<voip-room>` was inserted, changed its `openid` or `mode`, or was removed. */
  const voipRoomMounted = (
    webviewId: number,
    roomId: number,
    mounted: boolean,
    openid = "",
    mode = "camera",
  ) => {
    const key = `${webviewId}:${roomId}`;
    if (!mounted) {
      windows.delete(key);
      return;
    }
    const entry: VoipWindow = { webviewId, roomId, openid, mode };
    windows.set(key, entry);
    tellWindow(entry, true);
  };

  const leave = () => {
    if (!room) return;
    clearInterval(room.speaker);
    room.release();
    room = undefined;
    tellWindows();
  };
  /** Going to the background ends the chat (`onVoIPChatInterrupted` code -1). */
  const interrupt = () => {
    if (!room) return;
    leave();
    interrupted.emit({
      errCode: -1,
      errMsg: "onVoIPChatInterrupted:fail 由于退后台，导致会话中断",
    });
  };

  const requireRoom = () => {
    if (!room) throw new ApiError("not in a VoIP chat");
    return room;
  };

  const joinVoIPChat = asyncApi("joinVoIPChat", async (options: Options) => {
    requireParam(options, "signature", "String");
    requireParam(options, "nonceStr", "String");
    requireParam(options, "timeStamp", "Number");
    requireParam(options, "groupId", "String");
    if (room || joining) throw new ApiError("当前已在房间内", -1);
    const roomType = options.roomType === "video" ? "video" : "voice";
    joining = true;
    try {
      await ctx.requirePrivacy("joinVoIPChat");
      if (!(await ctx.requestScope("scope.record"))) throw new ApiError("auth deny");
      if (roomType === "video" && !(await ctx.requestScope("scope.camera"))) {
        throw new ApiError("auth deny");
      }
    } finally {
      joining = false;
    }
    const others = (host.manifest.config.voip?.members ?? DEFAULT_MEMBERS).filter(
      (openid) => openid !== selfOpenId,
    );
    const members = [selfOpenId, ...others];
    const holds = [ctx.holdPermission("record")];
    if (roomType === "video") holds.push(ctx.holdPermission("camera"));
    const mute = (options.muteConfig ?? {}) as Options;
    const joined: Room = {
      roomType,
      members,
      muteMicrophone: mute.muteMicrophone === true,
      muteEarphone: mute.muteEarphone === true,
      release: () => holds.forEach((release) => release()),
    };
    room = joined;
    // The other members take turns speaking
    let turn = 0;
    if (others.length > 0) {
      joined.speaker = setInterval(() => {
        speakersChanged.emit({ openIdList: [others[turn++ % others.length]] });
      }, SPEAKER_MS);
    }
    setTimeout(() => {
      if (room !== joined) return;
      tellWindows();
      if (roomType === "video") videoMembersChanged.emit({ openIdList: [...members] });
    }, 0);
    return { openIdList: [...members], errCode: 0 };
  });

  return {
    voipRoomMounted,
    interrupt,
    /** Forgets the `<voip-room>` windows of a closed page. */
    releasePage: (webviewId: number) => {
      for (const [key, entry] of windows) if (entry.webviewId === webviewId) windows.delete(key);
    },
    apis: {
      joinVoIPChat: withErrCode(joinVoIPChat),
      exitVoIPChat: asyncApi("exitVoIPChat", async () => {
        requireRoom();
        leave();
        return {};
      }),
      updateVoIPChatMuteConfig: asyncApi("updateVoIPChatMuteConfig", async (options) => {
        requireParam(options, "muteConfig", "Object");
        const current = requireRoom();
        const { muteMicrophone, muteEarphone } = options.muteConfig as Options;
        current.muteMicrophone = muteMicrophone === true;
        current.muteEarphone = muteEarphone === true;
        tellWindows();
        return {};
      }),
      subscribeVoIPVideoMembers: asyncApi("subscribeVoIPVideoMembers", async (options) => {
        requireParam(options, "openIdList", "Array");
        const current = requireRoom();
        if (current.roomType !== "video") throw new ApiError("the VoIP chat is not a video room");
        current.subscribed = (options.openIdList as unknown[]).map(String);
        tellWindows();
        return {};
      }),
      // Two-person calls ring in WeChat's own call screen, which the simulator does not draw
      setEnable1v1Chat: asyncApi("setEnable1v1Chat", async (options) => {
        requireParam(options, "enable", "Boolean");
        return {};
      }),
      join1v1Chat: asyncApi("join1v1Chat", async (options) => {
        requireParam(options, "caller", "Object");
        requireParam(options, "listener", "Object");
        await ctx.requirePrivacy("join1v1Chat");
        if (!(await ctx.requestScope("scope.record"))) throw new ApiError("auth deny");
        if (options.roomType === "video" && !(await ctx.requestScope("scope.camera"))) {
          throw new ApiError("auth deny");
        }
        return {};
      }),
      onVoIPChatMembersChanged: membersChanged.on,
      offVoIPChatMembersChanged: membersChanged.off,
      onVoIPChatSpeakersChanged: speakersChanged.on,
      offVoIPChatSpeakersChanged: speakersChanged.off,
      onVoIPChatInterrupted: interrupted.on,
      offVoIPChatInterrupted: interrupted.off,
      onVoIPChatStateChanged: stateChanged.on,
      offVoIPChatStateChanged: stateChanged.off,
      onVoIPVideoMembersChanged: videoMembersChanged.on,
      offVoIPVideoMembersChanged: videoMembersChanged.off,
    } as Record<string, unknown>,
  };
}
