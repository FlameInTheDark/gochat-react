import { useState, useEffect, useRef, useCallback } from "react";
import {
  X,
  Camera,
  LogOut,
  Trash2,
  AlertTriangle,
  RotateCcw,
  Globe,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthStore } from "@/stores/authStore";
import { performLogout } from "@/lib/logoutCleanup";
import { useUiStore } from "@/stores/uiStore";
import { useVoiceStore } from "@/stores/voiceStore";
import {
  useAppearanceStore,
  DEFAULT_CHAT_SPACING,
  DEFAULT_FONT_SCALE,
} from "@/stores/appearanceStore";
import { applyVoiceSettings } from "@/services/voiceService";
import {
  buildDenoiserNode,
  destroyDenoiserNode,
  effectiveDenoiserType,
  effectiveNoiseSuppression,
  type DenoiserNode,
} from "@/services/denoiserService";
import { useNavigate } from "react-router-dom";
import {
  userApi,
  uploadApi,
  axiosInstance,
  voiceApi,
  createProfileBannerUpload,
  uploadProfileBanner,
} from "@/api/client";
import { saveSettings } from "@/lib/settingsApi";
import type { ModelUserSettingsData, DtoUser } from "@/client";
import type { ProfileBannerUploadCrop } from "@/api/client";
import { cn } from "@/lib/utils";
import ImageCropDialog from "@/components/modals/ImageCropDialog";
import BannerCropDialog, {
  type BannerCropArea,
} from "@/components/modals/BannerCropDialog";
import MicTest from "@/components/voice/MicTest";
import OutputTest from "@/components/voice/OutputTest";
import VadSlider from "@/components/voice/VadSlider";
import { useTranslation } from "react-i18next";
import i18n, { SUPPORTED_LANGUAGES } from "@/i18n";
import { useClientMode } from "@/hooks/useClientMode";
import ProfileCardBody, {
  isDark,
  panelTextColors,
  userColor,
} from "@/components/layout/ProfileCardBody";
import { getApiBaseUrl } from "@/lib/connectionConfig";
import SecuritySection from "@/components/settings/SecuritySection";
import DeveloperBotsSection from "@/components/settings/DeveloperBotsSection";
import {
  devicesFromVoiceSettings,
  voiceSettingsFromDevices,
} from "@/lib/voiceSettings";
import type { VoiceSettings } from "@/stores/voiceStore";
import { eventToKeyCombo, formatKeyCombo } from "@/lib/keyCombo";

type Section =
  | "account"
  | "appearance"
  | "voice"
  | "language"
  | "developer"
  | "security"
  | "danger";
type UserSettingsWithVoice = ModelUserSettingsData & {
  voice?: {
    preferred_region?: string;
  };
};

type BannerEditDraft = {
  file: File;
  url: string;
  width: number;
  height: number;
};

type LocalBannerCrop = ProfileBannerUploadCrop & {
  sourceWidth: number;
  sourceHeight: number;
};

function numToHex(n: number | undefined | null, fallback: string): string {
  if (n == null) return fallback;
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

const DEFAULT_BANNER_COLOR = "#5865f2";
const DEFAULT_PANEL_COLOR = "#2b2d31";
const PROFILE_BANNER_MIN_WIDTH = 680;
const PROFILE_BANNER_MIN_HEIGHT = 240;
const PROFILE_BANNER_MAX_SIZE = 10 * 1024 * 1024;
const PROFILE_DISPLAY_NAME_MAX_LENGTH = 20;
const PROFILE_COLOR_PRESETS: { label: string; value: string }[] = [
  { label: "Red", value: "#f04747" },
  { label: "Orange", value: "#faa61a" },
  { label: "Yellow", value: "#ffd83d" },
  { label: "Green", value: "#43b581" },
  { label: "Teal", value: "#1abc9c" },
  { label: "Blue", value: "#7289da" },
  { label: "Indigo", value: "#5865f2" },
  { label: "Purple", value: "#b3a3e5" },
  { label: "Pink", value: "#e91e8c" },
];

function Toggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "relative w-10 h-5 rounded-full transition-colors shrink-0",
        value ? "bg-green-500" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform",
          value && "translate-x-5",
        )}
      />
    </button>
  );
}

function hasDevice(devices: MediaDeviceInfo[], deviceId: string): boolean {
  return devices.some((device) => device.deviceId === deviceId);
}

function getImageDimensions(
  file: File,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read image dimensions"));
    };
    img.src = url;
  });
}

function ColorPaletteField({
  label,
  value,
  defaultColor,
  customLabel,
  defaultLabel,
  resetLabel,
  onChange,
  onReset,
}: {
  label: string;
  value: string | null;
  defaultColor: string;
  customLabel: string;
  defaultLabel: string;
  resetLabel: string;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const normalizedValue = value?.toLowerCase() ?? null;
  const isCustomColor =
    normalizedValue !== null &&
    !PROFILE_COLOR_PRESETS.some((preset) => preset.value === normalizedValue);

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={`${customLabel}: ${label}`}
          onClick={() => colorInputRef.current?.click()}
          className={cn(
            "relative h-7 w-7 rounded-md border-2 border-dashed transition-colors",
            isCustomColor
              ? "border-foreground ring-2 ring-foreground/25 ring-offset-2 ring-offset-background"
              : "border-muted-foreground/55 hover:border-foreground/80",
          )}
          style={{ backgroundColor: value ?? defaultColor }}
        >
          <input
            ref={colorInputRef}
            type="color"
            value={value ?? defaultColor}
            aria-label={`${customLabel}: ${label}`}
            onChange={(e) => onChange(e.target.value)}
            className="sr-only"
          />
        </button>
        {PROFILE_COLOR_PRESETS.map((preset) => {
          const selected = normalizedValue === preset.value;
          return (
            <button
              key={preset.value}
              type="button"
              aria-label={`${label}: ${preset.label}`}
              onClick={() => onChange(preset.value)}
              className={cn(
                "h-7 w-7 rounded-md border-2 transition-colors",
                selected
                  ? "border-foreground ring-2 ring-foreground/25 ring-offset-2 ring-offset-background"
                  : "border-transparent opacity-80 hover:opacity-100",
              )}
              style={{ backgroundColor: preset.value }}
            />
          );
        })}
      </div>
      <div className="flex h-5 items-center gap-3">
        {value !== null ? (
          <>
            <span className="text-xs font-mono text-muted-foreground">
              {value.toUpperCase()}
            </span>
            <button
              type="button"
              onClick={onReset}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {resetLabel}
            </button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground italic">
            {defaultLabel}
          </span>
        )}
      </div>
    </div>
  );
}

export default function AppSettingsModal() {
  const open = useUiStore((s) => s.appSettingsOpen);
  const close = useUiStore((s) => s.closeAppSettings);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [section, setSection] = useState<Section>("account");
  const isMobile = useClientMode() === "mobile";
  const [mobileShowNav, setMobileShowNav] = useState(true);

  // Avatar upload
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [cropDialogOpen, setCropDialogOpen] = useState(false);
  const [cropImageDataUrl, setCropImageDataUrl] = useState("");
  const [localAvatarUrl, setLocalAvatarUrl] = useState<string | null>(null);
  const [localBannerUrl, setLocalBannerUrl] = useState<string | null>(null);
  const [localBannerCrop, setLocalBannerCrop] =
    useState<LocalBannerCrop | null>(null);
  const [bannerEditorOpen, setBannerEditorOpen] = useState(false);
  const [bannerDraft, setBannerDraft] = useState<BannerEditDraft | null>(null);

  // My Account
  const [name, setName] = useState("");
  const [editingPreviewName, setEditingPreviewName] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);

  // Profile customization — null means "no custom colour" (matches natural panel defaults)
  const [bio, setBio] = useState("");
  const [bannerColor, setBannerColor] = useState<string | null>(null);
  const [panelColor, setPanelColor] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  // Appearance
  const [fontScale, setFontScale] = useState(DEFAULT_FONT_SCALE);
  const [chatSpacing, setChatSpacing] = useState(DEFAULT_CHAT_SPACING);
  const [savingAppearance, setSavingAppearance] = useState(false);

  // Voice & Video
  const [audioInputDevice, setAudioInputDevice] = useState("");
  const [audioOutputDevice, setAudioOutputDevice] = useState("");
  const [inputLevel, setInputLevel] = useState(100);
  const [outputLevel, setOutputLevel] = useState(100);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [denoiserType, setDenoiserType] = useState<
    "default" | "rnnoise" | "speex"
  >("default");
  const [inputMode, setInputMode] = useState<"voice_activity" | "push_to_talk">(
    "voice_activity",
  );
  const [voiceActivityThreshold, setVoiceActivityThreshold] = useState(-60);
  const [pushToTalkKey, setPushToTalkKey] = useState("");
  const [pushToTalkToggle, setPushToTalkToggle] = useState(false);
  const [isRecordingPTTKey, setIsRecordingPTTKey] = useState(false);
  const [preferredVoiceRegion, setPreferredVoiceRegion] = useState("auto");
  const [savingVoice, setSavingVoice] = useState(false);
  const [voiceDirty, setVoiceDirty] = useState(false);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>(
    [],
  );
  const [audioOutputDevices, setAudioOutputDevices] = useState<
    MediaDeviceInfo[]
  >([]);
  const [videoInputDevice, setVideoInputDevice] = useState("");
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraPreviewStream, setCameraPreviewStream] =
    useState<MediaStream | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);

  // VAD sensitivity live meter
  const [vadMicVolume, setVadMicVolume] = useState(0); // 0–1 normalised RMS
  const vadMicStreamRef = useRef<MediaStream | null>(null);
  const vadMicCtxRef = useRef<AudioContext | null>(null);
  const vadMicRafRef = useRef<number | null>(null);
  const vadDenoiserRef = useRef<DenoiserNode | null>(null);

  // Language
  const [selectedLanguage, setSelectedLanguage] = useState(
    i18n.language ?? "en",
  );
  const [savingLanguage, setSavingLanguage] = useState(false);

  // Load saved settings
  const { data: settingsData } = useQuery({
    queryKey: ["user-settings"],
    queryFn: () =>
      userApi
        .userMeSettingsGet({})
        .then((r) => r.data?.settings as UserSettingsWithVoice | undefined),
    enabled: open,
    staleTime: 60_000,
  });

  const { data: settingsUser } = useQuery({
    queryKey: ["settings-user-me"],
    queryFn: () =>
      axiosInstance
        .get<DtoUser>(`${getApiBaseUrl()}/user/me`)
        .then((r) => r.data),
    enabled: open,
    staleTime: 60_000,
  });

  const { data: voiceRegions = [] } = useQuery({
    queryKey: ["voice-regions"],
    queryFn: () =>
      voiceApi.voiceRegionsGet().then((r) => r.data?.regions ?? []),
    enabled: open && section === "voice",
    staleTime: 5 * 60 * 1000,
  });

  // Init account form when modal opens
  useEffect(() => {
    if (open) {
      setName(user?.name ?? "");
      setBio(user?.bio ?? "");
      // 0 and undefined/null both mean "no custom colour" — use null so the
      // preview shows the same natural defaults as the real member panel
      setBannerColor(
        user?.banner_color
          ? numToHex(user.banner_color, DEFAULT_BANNER_COLOR)
          : null,
      );
      setPanelColor(
        user?.panel_color
          ? numToHex(user.panel_color, DEFAULT_PANEL_COLOR)
          : null,
      );
      setSection("account");
    }
  }, [open, user?.name, user?.bio, user?.banner_color, user?.panel_color]);

  useEffect(() => {
    if (open || !bannerDraft) return;
    URL.revokeObjectURL(bannerDraft.url);
    setBannerDraft(null);
    setBannerEditorOpen(false);
  }, [open, bannerDraft]);

  const {
    setFontScale: setAppearenceFontScale,
    setChatSpacing: setAppearanceChatSpacing,
  } = useAppearanceStore();

  // Init appearance from loaded settings
  useEffect(() => {
    if (settingsData?.appearance) {
      const fontScale =
        settingsData.appearance.chat_font_scale || DEFAULT_FONT_SCALE;
      const chatSpacing =
        settingsData.appearance.chat_spacing ?? DEFAULT_CHAT_SPACING;
      setFontScale(fontScale);
      setChatSpacing(chatSpacing);
      setAppearenceFontScale(fontScale);
      setAppearanceChatSpacing(chatSpacing);
    }
  }, [settingsData, setAppearenceFontScale, setAppearanceChatSpacing]);

  // Init language from loaded settings
  useEffect(() => {
    if (settingsData?.language) {
      setSelectedLanguage(settingsData.language);
    } else {
      setSelectedLanguage(i18n.language ?? "en");
    }
  }, [settingsData]);

  // Init voice from loaded settings
  useEffect(() => {
    if (!open) {
      setVoiceDirty(false);
      return;
    }
    if (voiceDirty) return;

    const next = voiceSettingsFromDevices(settingsData?.devices);
    if (!next) return;

    setAudioInputDevice(next.audioInputDevice ?? "");
    setAudioOutputDevice(next.audioOutputDevice ?? "");
    setInputLevel(next.audioInputLevel ?? 100);
    setOutputLevel(next.audioOutputLevel ?? 100);
    setAutoGainControl(next.autoGainControl ?? true);
    setEchoCancellation(next.echoCancellation ?? true);
    setNoiseSuppression(next.noiseSuppression ?? true);
    setVideoInputDevice(next.videoInputDevice ?? "");
    setDenoiserType(next.denoiserType ?? "default");
    setInputMode(next.inputMode ?? "voice_activity");
    setVoiceActivityThreshold(next.voiceActivityThreshold ?? -60);
    setPushToTalkKey(next.pushToTalkKey ?? "");
    setPushToTalkToggle(next.pushToTalkToggle ?? false);
    setPreferredVoiceRegion(
      settingsData?.voice?.preferred_region?.trim() || "auto",
    );
    setVoiceDirty(false);
  }, [
    open,
    settingsData?.devices,
    settingsData?.voice?.preferred_region,
    voiceDirty,
  ]);

  // Enumerate audio/video devices when switching to Voice section.
  // On mobile, device labels/IDs are empty until permission is granted — request
  // a brief audio stream first so the browser unlocks real device info.
  useEffect(() => {
    if (section !== "voice") return;
    const run = async () => {
      let permStream: MediaStream | null = null;
      try {
        permStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch {
        /* permission denied — enumerate anyway, may have empty labels */
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setAudioInputDevices(devices.filter((d) => d.kind === "audioinput"));
        setAudioOutputDevices(devices.filter((d) => d.kind === "audiooutput"));
        setVideoDevices(devices.filter((d) => d.kind === "videoinput"));
      } catch {
        /* ignore */
      } finally {
        permStream?.getTracks().forEach((t) => t.stop());
      }
    };
    void run();
  }, [section]);

  // Stop camera preview when leaving voice section or closing modal
  useEffect(() => {
    if (!open || section !== "voice") {
      setCameraPreviewStream((prev) => {
        if (prev) {
          prev.getTracks().forEach((t) => t.stop());
        }
        return null;
      });
    }
  }, [open, section]);

  // Attach camera preview stream to video element
  useEffect(() => {
    if (cameraPreviewRef.current && cameraPreviewStream) {
      cameraPreviewRef.current.srcObject = cameraPreviewStream;
    }
  }, [cameraPreviewStream]);

  // Live VAD sensitivity meter — runs a mic stream while the voice activity section is visible
  useEffect(() => {
    const shouldRun =
      open && section === "voice" && inputMode === "voice_activity";

    function stopMeter() {
      if (vadMicRafRef.current !== null) {
        cancelAnimationFrame(vadMicRafRef.current);
        vadMicRafRef.current = null;
      }
      destroyDenoiserNode(vadDenoiserRef.current);
      vadDenoiserRef.current = null;
      if (vadMicStreamRef.current) {
        for (const t of vadMicStreamRef.current.getTracks()) t.stop();
        vadMicStreamRef.current = null;
      }
      if (vadMicCtxRef.current && vadMicCtxRef.current.state !== "closed") {
        void vadMicCtxRef.current.close();
        vadMicCtxRef.current = null;
      }
      setVadMicVolume(0);
    }

    if (!shouldRun) {
      stopMeter();
      return;
    }

    let cancelled = false;
    const setup = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: audioInputDevice
              ? { exact: audioInputDevice }
              : undefined,
            autoGainControl,
            echoCancellation,
            noiseSuppression: effectiveNoiseSuppression(
              denoiserType,
              noiseSuppression,
            ),
          },
          video: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        vadMicStreamRef.current = stream;
        const ctx = new AudioContext();
        vadMicCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);

        // Apply denoiser so the meter shows the same level that the VAD engine sees during a call
        destroyDenoiserNode(vadDenoiserRef.current);
        vadDenoiserRef.current = await buildDenoiserNode(
          effectiveDenoiserType(denoiserType, noiseSuppression),
          ctx,
          source,
        );
        const postDenoise: AudioNode = vadDenoiserRef.current ?? source;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        postDenoise.connect(analyser);
        const floatData = new Float32Array(analyser.fftSize);
        const loop = () => {
          if (!vadMicCtxRef.current) return;
          analyser.getFloatTimeDomainData(floatData);
          let sum = 0;
          for (let i = 0; i < floatData.length; i++)
            sum += floatData[i] * floatData[i];
          const rms = Math.sqrt(sum / floatData.length);
          // Linear dBFS → 0–1 fill: same scale as the VAD engine and marker
          const db = Math.max(20 * Math.log10(Math.max(rms, 1e-8)), -100);
          setVadMicVolume(Math.max(0, (db + 100) / 100));
          vadMicRafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch {
        /* permission denied or device unavailable — no meter */
      }
    };
    void setup();

    return () => {
      cancelled = true;
      stopMeter();
    };
  }, [
    open,
    section,
    inputMode,
    audioInputDevice,
    autoGainControl,
    echoCancellation,
    noiseSuppression,
    denoiserType,
  ]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  // Reset mobile nav panel on open
  useEffect(() => {
    if (open) setMobileShowNav(true);
  }, [open]);

  // Mark voice dirty on any change
  const markVoiceDirty = useCallback(() => setVoiceDirty(true), []);

  // PTT key recording handler
  useEffect(() => {
    if (!isRecordingPTTKey) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = eventToKeyCombo(e);
      if (!combo) return;
      setPushToTalkKey(combo);
      setIsRecordingPTTKey(false);
      setVoiceDirty(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isRecordingPTTKey]);

  if (!open) return null;

  const initials = (user?.name ?? "?").charAt(0).toUpperCase();
  const profileDiscriminator =
    settingsUser?.discriminator || user?.discriminator || "";
  const nameChanged = name.trim() !== "" && name.trim() !== user?.name;
  const savedBannerColor = user?.banner_color
    ? numToHex(user.banner_color, DEFAULT_BANNER_COLOR)
    : null;
  const savedPanelColor = user?.panel_color
    ? numToHex(user.panel_color, DEFAULT_PANEL_COLOR)
    : null;
  const profileDirty =
    nameChanged ||
    bio !== (user?.bio ?? "") ||
    bannerColor !== savedBannerColor ||
    panelColor !== savedPanelColor;
  const profilePreviewUserId = String(user?.id ?? "default");
  const profilePreviewName = name.trim() || user?.name || initials;
  const profilePreviewAvatarUrl = localAvatarUrl ?? user?.avatar?.url;
  const profilePreviewBannerUrl = localBannerUrl ?? user?.banner?.url;
  const profilePreviewBannerCrop = localBannerUrl
    ? (localBannerCrop ?? undefined)
    : undefined;
  const previewText = panelTextColors(panelColor);
  const previewBioStyle = panelColor
    ? {
        color: previewText.textColor,
        borderColor: previewText.dividerColor,
        backgroundColor: isDark(panelColor)
          ? "rgba(255,255,255,0.08)"
          : "rgba(0,0,0,0.04)",
      }
    : undefined;
  const previewNameEditor = editingPreviewName ? (
    <input
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => setEditingPreviewName(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") setEditingPreviewName(false);
        if (e.key === "Escape") {
          setName(user?.name ?? "");
          setEditingPreviewName(false);
        }
      }}
      maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH}
      aria-label={t("settings.username")}
      className="w-full rounded-md border border-input bg-background/70 px-2 py-1 text-base font-bold leading-snug outline-none focus:ring-1 focus:ring-ring"
      style={previewBioStyle}
    />
  ) : (
    <button
      type="button"
      onClick={() => setEditingPreviewName(true)}
      className="block max-w-full truncate text-left text-base font-bold leading-snug outline-none hover:underline focus-visible:underline"
      style={{ color: previewText.textColor }}
      aria-label={t("settings.username")}
    >
      {profilePreviewName}
    </button>
  );

  const NAV: {
    key: Section;
    label: string;
    danger?: boolean;
    separator?: boolean;
  }[] = [
    { key: "account", label: t("settings.myAccount") },
    { key: "appearance", label: t("settings.appearance") },
    { key: "voice", label: t("settings.voiceVideo") },
    { key: "language", label: t("settings.language") },
    { key: "developer", label: t("settings.developer") },
    { key: "security", label: t("settings.security"), separator: true },
    { key: "danger", label: t("settings.dangerZone"), danger: true },
  ];

  async function patchSettings(update: Partial<UserSettingsWithVoice>) {
    await saveSettings(update);
  }

  // Step 1 — file picker opens → read as data URL → show crop dialog
  function handleAvatarFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // allow re-selecting the same file
    const reader = new FileReader();
    reader.onload = () => {
      setCropImageDataUrl(reader.result as string);
      setCropDialogOpen(true);
    };
    reader.readAsDataURL(file);
  }

  // Step 2 — crop confirmed → upload cropped JPEG blob
  async function handleAvatarCropConfirmed(blob: Blob) {
    setCropDialogOpen(false);
    // Optimistically show the cropped image immediately
    const optimisticUrl = URL.createObjectURL(blob);
    setLocalAvatarUrl(optimisticUrl);
    setUploadingAvatar(true);
    try {
      const baseUrl = getApiBaseUrl();
      const placeholder = await userApi.userMeAvatarPost({
        request: { content_type: "image/jpeg", file_size: blob.size },
      });
      const avatarId = String(placeholder.data.id);
      const userId = String(placeholder.data.user_id);
      await uploadApi.uploadAvatarsUserIdAvatarIdPost({
        userId,
        avatarId,
        file: blob as unknown as number[],
      });
      const meRes = await axiosInstance.get<DtoUser>(`${baseUrl}/user/me`);
      setUser(meRes.data);
      toast.success(t("settings.avatarUpdated"));
    } catch {
      toast.error(t("settings.avatarFailed"));
    } finally {
      setUploadingAvatar(false);
      URL.revokeObjectURL(optimisticUrl);
      setLocalAvatarUrl(null);
    }
  }

  async function handleSaveAccount() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === user?.name) return;
    setSavingAccount(true);
    try {
      await userApi.userMePatch({ request: { name: trimmed } });
      if (user) setUser({ ...user, name: trimmed });
      toast.success(t("settings.profileUpdated"));
    } catch {
      toast.error(t("settings.profileFailed"));
    } finally {
      setSavingAccount(false);
    }
  }

  async function handleSaveProfile() {
    setSavingProfile(true);
    try {
      const patch = {
        ...(nameChanged ? { name: name.trim() } : {}),
        bio: bio.trim() || undefined,
        // 0 signals "clear custom colour" to the backend (Go zero value = not set)
        banner_color: bannerColor !== null ? hexToNum(bannerColor) : 0,
        panel_color: panelColor !== null ? hexToNum(panelColor) : 0,
      };
      await userApi.userMePatch({ request: patch });
      if (user)
        setUser({
          ...user,
          ...(nameChanged ? { name: name.trim() } : {}),
          bio: bio.trim() || undefined,
          banner_color:
            bannerColor !== null ? hexToNum(bannerColor) : undefined,
          panel_color: panelColor !== null ? hexToNum(panelColor) : undefined,
        });
      setEditingPreviewName(false);
      toast.success(t("settings.profileUpdated"));
    } catch {
      toast.error(t("settings.profileFailed"));
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleSaveAppearance() {
    setSavingAppearance(true);
    try {
      await patchSettings({
        appearance: { chat_font_scale: fontScale, chat_spacing: chatSpacing },
      });
      setAppearenceFontScale(fontScale);
      setAppearanceChatSpacing(chatSpacing);
      toast.success(t("settings.appearanceSaved"));
    } catch {
      toast.error(t("settings.appearanceFailed"));
    } finally {
      setSavingAppearance(false);
    }
  }

  function handleLogout() {
    close();
    performLogout();
    navigate("/");
  }

  async function startCameraPreview() {
    try {
      const videoConstraint: MediaTrackConstraints | boolean = videoInputDevice
        ? { deviceId: { exact: videoInputDevice } }
        : isMobile
          ? { facingMode: "user" }
          : true;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraint,
        audio: false,
      });
      setCameraPreviewStream(stream);
      // Re-enumerate after permission granted so device labels become available
      const devices = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(devices.filter((d) => d.kind === "videoinput"));
      if (!videoInputDevice) {
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings();
        if (settings?.deviceId) setVideoInputDevice(settings.deviceId);
      }
    } catch {
      toast.error(t("settings.voiceFailed"));
    }
  }

  function stopCameraPreview() {
    setCameraPreviewStream((prev) => {
      if (prev) {
        prev.getTracks().forEach((t) => t.stop());
      }
      return null;
    });
  }

  async function handleSaveVoice() {
    setSavingVoice(true);
    try {
      const nextVoiceSettings: VoiceSettings = {
        audioInputDevice,
        audioOutputDevice,
        audioInputLevel: inputLevel,
        audioOutputLevel: outputLevel,
        autoGainControl,
        echoCancellation,
        noiseSuppression,
        inputMode,
        voiceActivityThreshold,
        pushToTalkKey,
        pushToTalkToggle,
        videoInputDevice,
        denoiserType,
      };
      await patchSettings({
        devices: devicesFromVoiceSettings(nextVoiceSettings),
        voice: { preferred_region: preferredVoiceRegion || "auto" },
      });
      useVoiceStore.getState().setSettings(nextVoiceSettings);
      applyVoiceSettings();
      setVoiceDirty(false);
      toast.success(t("settings.voiceSaved"));
    } catch {
      toast.error(t("settings.voiceFailed"));
    } finally {
      setSavingVoice(false);
    }
  }

  function handleResetVoiceDefaults() {
    setAudioInputDevice("");
    setAudioOutputDevice("");
    setInputLevel(100);
    setOutputLevel(100);
    setAutoGainControl(true);
    setEchoCancellation(true);
    setNoiseSuppression(true);
    setDenoiserType("default");
    setInputMode("voice_activity");
    setVoiceActivityThreshold(-60);
    setPushToTalkKey("");
    setPushToTalkToggle(false);
    setVideoInputDevice("");
    setPreferredVoiceRegion("auto");
    setVoiceDirty(true);
  }

  async function handleBannerFileSelected(
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error(t("settings.bannerFailed"));
      return;
    }
    if (file.size > PROFILE_BANNER_MAX_SIZE) {
      toast.error(t("settings.bannerTooLarge"));
      return;
    }

    try {
      const { width, height } = await getImageDimensions(file);
      if (
        width < PROFILE_BANNER_MIN_WIDTH ||
        height < PROFILE_BANNER_MIN_HEIGHT
      ) {
        toast.error(t("settings.bannerTooSmall"));
        return;
      }
      if (bannerDraft) {
        URL.revokeObjectURL(bannerDraft.url);
      }
      setBannerDraft({
        file,
        url: URL.createObjectURL(file),
        width,
        height,
      });
      setBannerEditorOpen(true);
    } catch {
      toast.error(t("settings.bannerFailed"));
    }
  }

  function handleBannerEditorCancel() {
    if (bannerDraft) {
      URL.revokeObjectURL(bannerDraft.url);
    }
    setBannerDraft(null);
    setBannerEditorOpen(false);
  }

  async function handleBannerCropApplied(crop: BannerCropArea) {
    if (!bannerDraft) return;

    const draft = bannerDraft;
    const optimisticCrop = {
      ...crop,
      sourceWidth: draft.width,
      sourceHeight: draft.height,
    };
    setBannerEditorOpen(false);
    setLocalBannerUrl(draft.url);
    setLocalBannerCrop(optimisticCrop);
    setUploadingBanner(true);

    try {
      const baseUrl = getApiBaseUrl();
      const placeholder = await createProfileBannerUpload(draft.file);
      const bannerId = String(placeholder.id);
      const userId = String(placeholder.user_id);
      await uploadProfileBanner(userId, bannerId, draft.file, crop);
      const meRes = await axiosInstance.get<DtoUser>(`${baseUrl}/user/me`);
      setUser(meRes.data);
      toast.success(t("settings.bannerUpdated"));
    } catch {
      toast.error(t("settings.bannerFailed"));
    } finally {
      setUploadingBanner(false);
      URL.revokeObjectURL(draft.url);
      setBannerDraft(null);
      setLocalBannerUrl(null);
      setLocalBannerCrop(null);
    }
  }

  async function handleSaveLanguage(code: string) {
    setSelectedLanguage(code);
    void i18n.changeLanguage(code);
    setSavingLanguage(true);
    try {
      await patchSettings({ language: code });
      toast.success(t("settings.languageSaved"));
    } catch {
      toast.error(t("settings.languageFailed"));
    } finally {
      setSavingLanguage(false);
    }
  }

  const selectClass =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <>
      <div className="fixed inset-0 z-50 flex bg-background/80 backdrop-blur-sm">
        <div
          className={cn(
            "flex w-full h-full overflow-hidden",
            isMobile && "flex-col",
          )}
        >
          {/* ── Mobile header ── */}
          {isMobile && (
            <div className="h-12 flex items-center px-3 border-b border-sidebar-border shrink-0 bg-sidebar">
              {!mobileShowNav && (
                <button
                  onClick={() => setMobileShowNav(true)}
                  className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors mr-1"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}
              <span className="font-semibold text-sm flex-1">
                {mobileShowNav
                  ? t("settings.userSettings")
                  : (NAV.find((n) => n.key === section)?.label ?? "")}
              </span>
              <button
                onClick={close}
                className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── Left sidebar ── */}
          <div
            className={cn(
              "bg-sidebar",
              isMobile
                ? mobileShowNav
                  ? "flex flex-col flex-1 min-h-0 overflow-y-auto"
                  : "hidden"
                : "flex shrink-0 w-44 lg:w-[35%] lg:justify-end border-r border-sidebar-border",
            )}
          >
            <div
              className={cn(
                "shrink-0",
                isMobile ? "w-full py-4 px-3" : "w-full py-16 px-3 lg:w-52",
              )}
            >
              <p className="px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1">
                {t("settings.userSettings")}
              </p>
              <div className="space-y-0.5">
                {NAV.map((s, i) => (
                  <div key={s.key}>
                    {s.separator && i > 0 && (
                      <div className="my-2 h-px bg-border mx-3" />
                    )}
                    <button
                      onClick={() => {
                        setSection(s.key);
                        if (isMobile) setMobileShowNav(false);
                      }}
                      className={cn(
                        "w-full text-left px-3 rounded text-sm transition-colors flex items-center justify-between",
                        isMobile ? "py-3" : "py-1.5",
                        s.danger
                          ? section === s.key
                            ? "bg-destructive/20 text-destructive"
                            : "text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                          : section === s.key
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                      )}
                    >
                      {s.label}
                      {isMobile && (
                        <ChevronRight className="w-4 h-4 shrink-0" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Content ── */}
          <div
            className={cn(
              "flex flex-1 min-w-0 min-h-0",
              isMobile && (mobileShowNav ? "hidden" : "flex"),
            )}
          >
            <div
              className={cn(
                "flex-1 overflow-y-auto h-full",
                section === "developer" ? "max-w-5xl" : "max-w-3xl",
                isMobile ? "py-4 px-4" : "py-16 px-8",
              )}
            >
              {/* My Account */}
              {section === "account" && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold">
                    {t("settings.myAccount")}
                  </h2>

                  <div className="flex items-center gap-4 p-4 rounded-lg bg-accent/30">
                    {/* Clickable avatar with camera overlay */}
                    <div
                      className="relative shrink-0 group cursor-pointer"
                      onClick={() =>
                        !uploadingAvatar && avatarInputRef.current?.click()
                      }
                      aria-label={t("settings.changeAvatar")}
                    >
                      <Avatar className="w-16 h-16 text-2xl">
                        <AvatarImage
                          src={localAvatarUrl ?? user?.avatar?.url}
                          alt={user?.name ?? ""}
                          className="object-cover"
                        />
                        <AvatarFallback className="bg-primary text-primary-foreground text-2xl font-bold">
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                      {/* Hover overlay */}
                      {!uploadingAvatar && (
                        <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                          <Camera className="w-5 h-5 text-white" />
                        </div>
                      )}
                      {/* Upload spinner */}
                      {uploadingAvatar && (
                        <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
                          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        </div>
                      )}
                    </div>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleAvatarFileSelected}
                    />
                    <div>
                      <p className="font-semibold text-lg">{user?.name}</p>
                      {profileDiscriminator && (
                        <p className="text-sm text-muted-foreground">
                          @{profileDiscriminator}
                        </p>
                      )}
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label htmlFor="settings-username">
                      {t("settings.username")}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="settings-username"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleSaveAccount();
                        }}
                        placeholder={t("settings.username")}
                        maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH}
                        className="flex-1"
                      />
                      <Button
                        onClick={() => void handleSaveAccount()}
                        disabled={savingAccount || !nameChanged}
                      >
                        {t("settings.save")}
                      </Button>
                    </div>
                  </div>

                  {profileDiscriminator && (
                    <div className="space-y-2">
                      <Label>{t("settings.discriminator")}</Label>
                      <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md">
                        @{profileDiscriminator}
                      </p>
                    </div>
                  )}

                  <Separator />

                  <div className="space-y-2">
                    <Label>{t("settings.userId")}</Label>
                    <div className="flex gap-2 items-center">
                      <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md flex-1 font-mono truncate">
                        {String(user?.id ?? "")}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            String(user?.id ?? ""),
                          );
                          toast.success(t("settings.copy"));
                        }}
                      >
                        {t("common.copy")}
                      </Button>
                    </div>
                  </div>

                  <Separator />

                  {/* Profile customization */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.profileCustomization")}
                    </h3>

                    <div className="flex flex-col gap-4 md:flex-row md:items-start">
                      <div className="min-w-0 flex-1 space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                          <ColorPaletteField
                            label={t("settings.bannerColor")}
                            value={bannerColor}
                            defaultColor={DEFAULT_BANNER_COLOR}
                            customLabel="Custom color"
                            defaultLabel={t("settings.denoiserDefault")}
                            resetLabel={t("settings.resetToDefaults")}
                            onChange={setBannerColor}
                            onReset={() => setBannerColor(null)}
                          />

                          <ColorPaletteField
                            label={t("settings.panelColor")}
                            value={panelColor}
                            defaultColor={DEFAULT_PANEL_COLOR}
                            customLabel="Custom color"
                            defaultLabel={t("settings.denoiserDefault")}
                            resetLabel={t("settings.resetToDefaults")}
                            onChange={setPanelColor}
                            onReset={() => setPanelColor(null)}
                          />
                        </div>

                        <Button
                          onClick={() => void handleSaveProfile()}
                          disabled={savingProfile || !profileDirty}
                        >
                          {savingProfile
                            ? t("settings.saving")
                            : t("settings.save")}
                        </Button>
                      </div>

                      <div
                        className={cn(
                          "w-[300px] shrink-0 rounded-lg overflow-hidden shadow-lg border border-border",
                          !panelColor && "bg-popover",
                        )}
                        style={
                          panelColor
                            ? { backgroundColor: panelColor }
                            : undefined
                        }
                      >
                        <ProfileCardBody
                          userId={profilePreviewUserId}
                          displayName={profilePreviewName}
                          discriminator={profileDiscriminator || undefined}
                          avatarUrl={profilePreviewAvatarUrl}
                          bannerUrl={profilePreviewBannerUrl}
                          bannerCrop={profilePreviewBannerCrop}
                          panelColor={panelColor}
                          bannerColor={bannerColor}
                          accent={userColor(profilePreviewUserId)}
                          onAvatarClick={() =>
                            !uploadingAvatar && avatarInputRef.current?.click()
                          }
                          onBannerClick={() =>
                            !uploadingBanner && bannerInputRef.current?.click()
                          }
                          avatarBusy={uploadingAvatar}
                          bannerBusy={uploadingBanner}
                          avatarActionLabel={t("settings.changeAvatar")}
                          bannerActionLabel={t("settings.changeBanner")}
                          displayNameEditor={previewNameEditor}
                          bioEditor={
                            <textarea
                              id="settings-bio"
                              aria-label={t("settings.bio")}
                              value={bio}
                              onChange={(e) => setBio(e.target.value)}
                              placeholder={t("settings.bioPlaceholder")}
                              rows={3}
                              maxLength={190}
                              className="min-h-20 w-full resize-none rounded-md border border-input bg-background/70 px-3 py-2 text-xs leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                              style={previewBioStyle}
                            />
                          }
                        />
                      </div>
                      <input
                        ref={bannerInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) =>
                          void handleBannerFileSelected(event)
                        }
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Appearance */}
              {section === "appearance" && (
                <div className="space-y-8">
                  <h2 className="text-xl font-bold">
                    {t("settings.appearance")}
                  </h2>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t("settings.chatFontScale")}</Label>
                      <span className="text-sm font-medium tabular-nums">
                        {Math.round(fontScale * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.75}
                      max={1.5}
                      step={0.05}
                      value={fontScale}
                      onChange={(e) => setFontScale(Number(e.target.value))}
                      className="w-full accent-primary"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground select-none">
                      <span>75%</span>
                      <span>100%</span>
                      <span>150%</span>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t("settings.messageSpacing")}</Label>
                      <span className="text-sm font-medium tabular-nums">
                        {chatSpacing}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={32}
                      step={4}
                      value={chatSpacing}
                      onChange={(e) => setChatSpacing(Number(e.target.value))}
                      className="w-full accent-primary"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground select-none">
                      <span>{t("settings.compact")}</span>
                      <span>{t("settings.comfortable")}</span>
                      <span>{t("settings.spacious")}</span>
                    </div>
                  </div>

                  <Separator />

                  {/* Live preview */}
                  <div className="space-y-2">
                    <Label>{t("settings.preview")}</Label>
                    <div
                      className="rounded-lg border border-border bg-background p-4"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: `${chatSpacing}px`,
                      }}
                    >
                      {(
                        [
                          "Hello there! 👋",
                          "Hey! How are you doing?",
                          "Pretty good, thanks!",
                        ] as const
                      ).map((msg, i) => (
                        <div key={i} className="flex items-start gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary/80 flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0 select-none">
                            {["A", "B", "A"][i]}
                          </div>
                          <div>
                            <span className="font-semibold text-sm mr-2">
                              {["Alice", "Bob", "Alice"][i]}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              Today at 12:0{i}
                            </span>
                            <p
                              style={{ fontSize: `${fontScale}rem` }}
                              className="mt-0.5 leading-snug"
                            >
                              {msg}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button
                      onClick={() => void handleSaveAppearance()}
                      disabled={savingAppearance}
                    >
                      {savingAppearance
                        ? t("settings.saving")
                        : t("settings.saveChanges")}
                    </Button>
                  </div>
                </div>
              )}

              {/* Voice & Video */}
              {section === "voice" && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold">
                    {t("settings.voiceVideo")}
                  </h2>

                  <div className="space-y-2">
                    <Label htmlFor="preferred-voice-region">
                      Preferred Voice Region
                    </Label>
                    <select
                      id="preferred-voice-region"
                      value={preferredVoiceRegion}
                      onChange={(e) => {
                        setPreferredVoiceRegion(e.target.value);
                        markVoiceDirty();
                      }}
                      className={selectClass}
                    >
                      <option value="auto">Automatic</option>
                      {voiceRegions.map((region) => (
                        <option
                          key={region.id ?? region.name}
                          value={region.id ?? ""}
                        >
                          {region.name || region.id}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Used for DM calls and automatic voice channels.
                    </p>
                  </div>

                  <Separator />

                  {/* ── Input Device ── */}
                  <div className="space-y-2">
                    <Label htmlFor="audio-input">
                      {t("settings.inputDevice")}
                    </Label>
                    <select
                      id="audio-input"
                      value={audioInputDevice}
                      onChange={(e) => {
                        setAudioInputDevice(e.target.value);
                        markVoiceDirty();
                      }}
                      className={selectClass}
                    >
                      <option value="">{t("settings.defaultDevice")}</option>
                      {audioInputDevice &&
                        !hasDevice(audioInputDevices, audioInputDevice) && (
                          <option value={audioInputDevice}>
                            {t("settings.savedInputDeviceUnavailable")}
                          </option>
                        )}
                      {audioInputDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t("settings.inputVolume")}</Label>
                      <span className="text-sm font-medium tabular-nums">
                        {inputLevel}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={5}
                      value={inputLevel}
                      onChange={(e) => {
                        setInputLevel(Number(e.target.value));
                        markVoiceDirty();
                      }}
                      className="w-full accent-primary"
                    />
                  </div>

                  <Separator />

                  {/* ── Output Device ── */}
                  <div className="space-y-2">
                    <Label htmlFor="audio-output">
                      {t("settings.outputDevice")}
                    </Label>
                    <select
                      id="audio-output"
                      value={audioOutputDevice}
                      onChange={(e) => {
                        setAudioOutputDevice(e.target.value);
                        markVoiceDirty();
                      }}
                      className={selectClass}
                    >
                      <option value="">{t("settings.defaultDevice")}</option>
                      {audioOutputDevice &&
                        !hasDevice(audioOutputDevices, audioOutputDevice) && (
                          <option value={audioOutputDevice}>
                            {t("settings.savedOutputDeviceUnavailable")}
                          </option>
                        )}
                      {audioOutputDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Speaker (${d.deviceId.slice(0, 8)}…)`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t("settings.outputVolume")}</Label>
                      <span className="text-sm font-medium tabular-nums">
                        {outputLevel}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={5}
                      value={outputLevel}
                      onChange={(e) => {
                        setOutputLevel(Number(e.target.value));
                        markVoiceDirty();
                      }}
                      className="w-full accent-primary"
                    />
                  </div>

                  {/* ── Output Test ── */}
                  <OutputTest
                    outputDeviceId={audioOutputDevice}
                    outputLevel={outputLevel}
                  />

                  <Separator />

                  {/* ── Camera Device ── */}
                  <div className="space-y-2">
                    <Label htmlFor="video-input">
                      {t("settings.videoDevice")}
                    </Label>
                    <select
                      id="video-input"
                      value={videoInputDevice}
                      onChange={(e) => {
                        setVideoInputDevice(e.target.value);
                        markVoiceDirty();
                        stopCameraPreview();
                      }}
                      className={selectClass}
                    >
                      <option value="">{t("settings.defaultDevice")}</option>
                      {videoInputDevice &&
                        !hasDevice(videoDevices, videoInputDevice) && (
                          <option value={videoInputDevice}>
                            {t("settings.savedVideoDeviceUnavailable")}
                          </option>
                        )}
                      {videoDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Camera (${d.deviceId.slice(0, 8)}…)`}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* ── Camera Preview ── */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t("settings.cameraPreview")}</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (cameraPreviewStream) {
                            stopCameraPreview();
                          } else {
                            void startCameraPreview();
                          }
                        }}
                      >
                        {cameraPreviewStream
                          ? t("settings.stopPreview")
                          : t("settings.testCamera")}
                      </Button>
                    </div>
                    {cameraPreviewStream ? (
                      <video
                        ref={cameraPreviewRef}
                        autoPlay
                        muted
                        playsInline
                        className="w-full aspect-video rounded-lg bg-black object-cover"
                      />
                    ) : (
                      <div className="w-full aspect-video rounded-lg bg-muted flex items-center justify-center">
                        <p className="text-xs text-muted-foreground">
                          {t("voicePanel.cameraOff")}
                        </p>
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* ── Mic Test ── */}
                  <MicTest
                    inputDeviceId={audioInputDevice}
                    inputLevel={inputLevel}
                    autoGainControl={autoGainControl}
                    echoCancellation={echoCancellation}
                    noiseSuppression={noiseSuppression}
                    denoiserType={denoiserType}
                    outputDeviceId={audioOutputDevice}
                    outputLevel={outputLevel}
                    inputMode={inputMode}
                    voiceActivityThreshold={voiceActivityThreshold}
                  />

                  <Separator />

                  {/* ── Input Mode ── */}
                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("settings.inputMode")}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setInputMode("voice_activity");
                          markVoiceDirty();
                        }}
                        className={cn(
                          "flex-1 px-4 py-2.5 rounded-md border text-sm font-medium transition-colors",
                          inputMode === "voice_activity"
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-muted-foreground",
                        )}
                      >
                        {t("settings.voiceActivity")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setInputMode("push_to_talk");
                          markVoiceDirty();
                        }}
                        className={cn(
                          "flex-1 px-4 py-2.5 rounded-md border text-sm font-medium transition-colors",
                          inputMode === "push_to_talk"
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-muted-foreground",
                        )}
                      >
                        {t("settings.pushToTalk")}
                      </button>
                    </div>

                    {inputMode === "voice_activity" && (
                      <div className="space-y-2 pt-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm text-muted-foreground">
                            {t("settings.sensitivityThreshold")}
                          </Label>
                          <span className="text-sm font-medium tabular-nums">
                            {voiceActivityThreshold} dBFS
                          </span>
                        </div>

                        <VadSlider
                          value={voiceActivityThreshold}
                          onChange={(v) => {
                            setVoiceActivityThreshold(v);
                            markVoiceDirty();
                          }}
                          vadVolume={vadMicVolume}
                        />
                        <div className="flex justify-between text-[10px] text-muted-foreground select-none">
                          <span>{t("settings.sensitive")}</span>
                          <span>{t("settings.aggressive")}</span>
                        </div>
                      </div>
                    )}

                    {inputMode === "push_to_talk" && (
                      <div className="space-y-3 pt-1">
                        <Label className="text-sm text-muted-foreground">
                          {t("settings.shortcut")}
                        </Label>
                        <div className="flex gap-2 items-center">
                          <button
                            type="button"
                            onClick={() => setIsRecordingPTTKey(true)}
                            className={cn(
                              "flex-1 px-3 py-2 rounded-md border text-sm text-left transition-colors",
                              isRecordingPTTKey
                                ? "border-primary bg-primary/10 text-primary animate-pulse"
                                : "border-border bg-background text-foreground hover:border-muted-foreground",
                            )}
                          >
                            {isRecordingPTTKey
                              ? t("settings.pressKeyCombo")
                              : pushToTalkKey
                                ? formatKeyCombo(pushToTalkKey)
                                : t("settings.clickToSetKey")}
                          </button>
                          {pushToTalkKey && !isRecordingPTTKey && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setPushToTalkKey("");
                                markVoiceDirty();
                              }}
                              className="text-muted-foreground"
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>

                        <div className="flex items-center justify-between py-1.5 gap-4">
                          <div className="min-w-0">
                            <p className="text-sm">
                              {t("settings.pushToTalkToggleMode")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t("settings.pushToTalkToggleModeDesc")}
                            </p>
                          </div>
                          <Toggle
                            value={pushToTalkToggle}
                            onToggle={() => {
                              setPushToTalkToggle((v) => !v);
                              markVoiceDirty();
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* ── Audio Processing Toggles ── */}
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      {t("settings.audioProcessing")}
                    </p>
                    <div className="space-y-1">
                      {[
                        {
                          label: t("settings.echoCancellation"),
                          desc: t("settings.echoCancellationDesc"),
                          value: echoCancellation,
                          onToggle: () => {
                            setEchoCancellation((v) => !v);
                            markVoiceDirty();
                          },
                        },
                        {
                          label: t("settings.autoGainControl"),
                          desc: t("settings.autoGainControlDesc"),
                          value: autoGainControl,
                          onToggle: () => {
                            setAutoGainControl((v) => !v);
                            markVoiceDirty();
                          },
                        },
                      ].map(({ label, desc, value, onToggle }) => (
                        <div
                          key={label}
                          className="flex items-center justify-between py-2.5 gap-4"
                        >
                          <div className="min-w-0">
                            <p className="text-sm">{label}</p>
                            <p className="text-xs text-muted-foreground">
                              {desc}
                            </p>
                          </div>
                          <Toggle value={value} onToggle={onToggle} />
                        </div>
                      ))}

                      {/* Noise Suppression mode selector */}
                      <div className="py-2.5">
                        <p className="text-sm mb-1">
                          {t("settings.noiseSuppression")}
                        </p>
                        <p className="text-xs text-muted-foreground mb-2">
                          {t("settings.noiseSuppressionDesc")}
                        </p>
                        <div className="flex gap-2 flex-wrap">
                          {(
                            [
                              {
                                value: "default",
                                label: t("settings.denoiserDefault"),
                              },
                              {
                                value: "rnnoise",
                                label: t("settings.denoiserRnnoise"),
                              },
                              {
                                value: "speex",
                                label: t("settings.denoiserSpeex"),
                              },
                            ] as const
                          ).map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => {
                                setDenoiserType(opt.value);
                                markVoiceDirty();
                              }}
                              className={cn(
                                "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                                denoiserType === opt.value
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "border-input bg-background hover:bg-accent hover:text-accent-foreground",
                              )}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        {/* Global enable/disable toggle — always visible */}
                        <div className="flex items-center justify-between mt-3 py-1 gap-4">
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">
                              {t("settings.noiseSuppressionEnabled")}
                            </p>
                          </div>
                          <Toggle
                            value={noiseSuppression}
                            onToggle={() => {
                              setNoiseSuppression((v) => !v);
                              markVoiceDirty();
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ── Action Buttons ── */}
                  <div className="flex items-center justify-between pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleResetVoiceDefaults}
                      className="gap-2 text-muted-foreground"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {t("settings.resetToDefaults")}
                    </Button>
                    <Button
                      onClick={() => void handleSaveVoice()}
                      disabled={savingVoice || !voiceDirty}
                    >
                      {savingVoice
                        ? t("settings.saving")
                        : t("settings.saveChanges")}
                    </Button>
                  </div>
                </div>
              )}

              {/* Language */}
              {section === "language" && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Globe className="w-5 h-5" />
                    {t("settings.language")}
                  </h2>

                  <div className="space-y-3">
                    <div>
                      <Label>{t("settings.selectLanguage")}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t("settings.selectLanguageDesc")}
                      </p>
                    </div>

                    <div className="space-y-2">
                      {SUPPORTED_LANGUAGES.map((lang) => (
                        <button
                          key={lang.code}
                          type="button"
                          onClick={() => {
                            if (!savingLanguage)
                              void handleSaveLanguage(lang.code);
                          }}
                          className={cn(
                            "w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-sm font-medium transition-colors",
                            selectedLanguage === lang.code
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-muted-foreground hover:bg-accent/50",
                          )}
                        >
                          <Globe className="w-4 h-4 shrink-0" />
                          <span className="flex-1 text-left">
                            {lang.nativeName}
                          </span>
                          {selectedLanguage === lang.code && (
                            <span className="text-xs text-primary font-normal">
                              ✓
                            </span>
                          )}
                        </button>
                      ))}
                    </div>

                    {savingLanguage && (
                      <p className="text-xs text-muted-foreground">
                        {t("settings.saving")}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Security */}
              {section === "security" && <SecuritySection />}

              {/* Developer */}
              {section === "developer" && <DeveloperBotsSection />}

              {/* Danger Zone */}
              {section === "danger" && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                    {t("settings.dangerZone")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.dangerDesc")}
                  </p>

                  {/* Log Out */}
                  <div className="rounded-lg border border-border p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-sm">
                        {t("settings.logOut")}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t("settings.logOutDesc")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-2"
                      onClick={handleLogout}
                    >
                      <LogOut className="w-4 h-4" />
                      {t("settings.logOut")}
                    </Button>
                  </div>

                  {/* Delete Account */}
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-sm text-destructive">
                        {t("settings.deleteAccount")}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t("settings.deleteAccountDesc")}
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="shrink-0 gap-2"
                      disabled
                    >
                      <Trash2 className="w-4 h-4" />
                      {t("settings.delete")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Close button — desktop only */}
            {!isMobile && (
              <div className="pt-16 pr-6 shrink-0">
                <button
                  onClick={close}
                  className="w-9 h-9 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Avatar crop dialog — rendered above the settings modal */}
      <ImageCropDialog
        open={cropDialogOpen}
        imageDataUrl={cropImageDataUrl}
        onCancel={() => setCropDialogOpen(false)}
        onCrop={(blob) => void handleAvatarCropConfirmed(blob)}
      />

      <BannerCropDialog
        open={bannerEditorOpen}
        mediaUrl={bannerDraft?.url ?? ""}
        sourceWidth={bannerDraft?.width ?? PROFILE_BANNER_MIN_WIDTH}
        sourceHeight={bannerDraft?.height ?? PROFILE_BANNER_MIN_HEIGHT}
        onCancel={handleBannerEditorCancel}
        onApply={(crop) => void handleBannerCropApplied(crop)}
      />
    </>
  );
}
