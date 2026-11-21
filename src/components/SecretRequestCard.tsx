import { useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink, Loader2, LockKeyhole, RefreshCw } from "../icons";

import { CUSTOM_SECRET_TARGET, credentialResumeOutcome, credentialSaveRequest, desktopCredentialSlot, isConfigCredentialTarget, isCredentialTargetId } from "../../shared/credential-request";
import { credentialProvider } from "@/lib/analytics-allowlist";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { keySaved, keySaveFailure, savedKeyResult } from "@/lib/product-events";
import { api, ApiError, useStore, type Bot, type ConfigStatus, type Message } from "@/state/store";
import { friendlyError, plainErrorLine } from "@/lib/plain-error";
import { ASK_QUIET_BUTTON, AskCard, CARD_FIELD, CardSettledRow, cardPrimary, returnFocusToComposer } from "./AskCard";
import { EmailServerInputs } from "./EmailCard";
import type { EmailServerFields } from "../../shared/email";
import { productName } from "@/lib/brand";
import { sealCardSecret, SealTrustError } from "@/lib/card-seal";
import type { CardSealKey } from "../../shared/saved-secrets";
import { Icon } from "./Icon";
import { Toggle } from "./ui/Toggle";
import { useSettleFold } from "./settle-fold";

// Security: the value goes straight to the host's settings, never into the chat. A custom secret leaves this app only
// sealed for the server that keeps it, so a relay between them (the VPS tunnel, a Cloud's proxy) never reads it.

/** What a failed send says: the server's own plain words, never a stack, a module address or a crypto error. */
export function secretErrorLine(error: unknown): string {
  if (error instanceof SealTrustError) return t("seal.untrusted");
  if (error instanceof ApiError) return friendlyError(error, t("secretCard.sendFailed"));
  return t("secretCard.sendFailed");
}

/** Grok's settled secret card: one row, the key in its tile, "Secrets", then one grey line with what happened. */
export function SecretSettledRow({ label, status, tone = "done", title, action, detail }: {
  label: string;
  status: string;
  tone?: "done" | "off" | "failed";
  title?: string;
  action?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <CardSettledRow ariaLabel={label} icon={<Icon name="key" size={12} />} label={t("secretCard.title")} summary={status}
      tone={tone === "off" ? "closed" : tone} title={title || detail ? label : undefined} detail={title || detail ? <>{title}{detail}</> : undefined} action={action} />
  );
}

type SecretRequestCardProps = {
  botId: string;
  color?: Bot["color"];
  threadId: string;
  message: Message;
};

export function SecretRequestCard(props: SecretRequestCardProps) {
  const secret = props.message.secret!;
  const settled = credentialResumeOutcome(secret) !== null || secret.superseded === true || secret.stopped === true;
  const fold = useSettleFold<HTMLDivElement>(settled);
  return <div ref={fold} className="w-full max-w-[560px]"><SecretRequestCardBody {...props} /></div>;
}

export function SecretRequestCardBody({
  botId,
  threadId,
  message,
}: SecretRequestCardProps) {
  const { dispatch } = useStore();
  const secret = message.secret!;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const email = secret.delivery === "email";
  // a website login: fill_login types it into the site, so the bot never receives it
  const login = secret.delivery === "login";
  const [username, setUsername] = useState("");
  const [totp, setTotp] = useState("");
  const [address, setAddress] = useState(secret.address ?? "");
  const [server, setServer] = useState<EmailServerFields>({});
  const [needsServer, setNeedsServer] = useState(false);
  // Grok's default: a custom secret is saved to the Vault so the bot can use it again; off, it is used once and forgotten.
  const [remember, setRemember] = useState(true);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? (secret.error ? plainErrorLine(secret.error) ?? friendlyError(secret.error) : undefined);
  const custom = secret.target === CUSTOM_SECRET_TARGET;
  // A page reached through a desktop paired to another computer: a key that computer keeps in its own encrypted store can
  // only be typed there. Anything its server keeps, a custom secret or a provider key, is typed here like on any page.
  const onlyOnHost = window.madaniDesktop?.remoteClient?.active === true && secret.target !== CUSTOM_SECRET_TARGET && desktopCredentialSlot(secret.target) !== null;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const superseded = secret.superseded === true;
  const stopped = secret.stopped === true;
  const description = superseded
    ? "This request was replaced by a newer one for the same key. Use the newest card to provide it."
    : provided
    ? stopped
      ? "Saved securely."
      : secret.resumed
      ? "Saved securely. Your bot is continuing the task."
      : "Saved securely. Your bot will continue when its current turn settles."
    : declined
      ? `You chose not to provide this credential. ${productName()} could not resume the bot yet.`
      : custom && secret.reason ? secret.reason : secret.description;
  if (!custom && !isCredentialTargetId(secret.target)) return <SecretSettledRow label={secret.label} tone="off" status="This credential request is no longer supported." />;

  const notifyProvided = async () => {
    await api(`${endpoint}/provided`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
  };

  const retryResume = async () => {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (error) {
      setLocalError(secretErrorLine(error));
    } finally {
      setSaving(false);
    }
  };

  // Kept behind the card on the server, never in Settings; saving it resumes the bot, and no product event names it.
  const saveCustom = async () => {
    if (saving || !value.trim()) return;
    setSaving(true);
    setLocalError(null);
    try {
      // A password goes as typed: a mailbox's can begin or end with a space.
      const typed = login ? JSON.stringify({ password: value, totp: totp.trim() }) : email ? value : value.trim();
      const keep = !email && remember;
      const send = async (key: CardSealKey) => {
        const sealed = await sealCardSecret(typed, key, { botId, threadId, messageId: message.id, requestKey: secret.requestKey, remember: keep });
        return api(`${endpoint}/save`, { method: "POST", body: JSON.stringify(email ? { threadId, sealed, address: address.trim(), ...server }
          : login ? { threadId, sealed, remember: keep, username: username.trim() } : { threadId, sealed, remember: keep }) });
      };
      const prepared = await api(`${endpoint}/save`, { method: "POST", body: JSON.stringify({ threadId, prepare: true }) }) as { sealKey: CardSealKey };
      try {
        await send(prepared.sealKey);
      } catch (error) {
        // The server restarted between the two steps: seal once more for its new key.
        const fresh = (error as { body?: { sealKey?: CardSealKey } }).body?.sealKey;
        if (!fresh || fresh.keyId === prepared.sealKey.keyId) throw error;
        await send(fresh);
      }
      setValue("");
      setTotp("");
      returnFocusToComposer();
    } catch (error) {
      if ((error as { body?: { needsServer?: unknown } }).body?.needsServer === true) setNeedsServer(true);
      // what was typed stays in the fields, so trying again is one press
      setLocalError(secretErrorLine(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (custom) return saveCustom();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    const provider = credentialProvider(secret.target);
    let saved = savedLocally;
    try {
      if (!savedLocally && secret.target !== CUSTOM_SECRET_TARGET) {
        const next = value.trim();
        const target = secret.target;
        // The 1Password token goes to this server's Logins, which checks it with 1Password first, never the settings file.
        const request = credentialSaveRequest(target, next);
        const slot = desktopCredentialSlot(target);
        if (isConfigCredentialTarget(target)) {
          const status: ConfigStatus = slot && window.madaniDesktop?.setCredential
            ? await window.madaniDesktop.setCredential(slot, next)
            : await api(request.path, { method: request.method, body: JSON.stringify(request.body) });
          dispatch({ type: "configStatus", config: status });
        } else await api(request.path, { method: request.method, body: JSON.stringify(request.body) });
        saved = true;
        keySaved(provider, "chat_request", savedKeyResult(provider));
        setValue("");
        setSavedLocally(true);
      }
      await notifyProvided();
      returnFocusToComposer();
    } catch (error) {
      if (!saved) keySaved(provider, "chat_request", keySaveFailure(error));
      setLocalError(secretErrorLine(error));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    }).catch(() => {});
  };

  if (superseded) {
    return <SecretSettledRow label={secret.label} tone="off" title={description} status={t("secretCard.replaced", { label: secret.label })} />;
  }

  if (stopped && !provided) {
    return <SecretSettledRow label={secret.label} tone="off" title={secret.description} status={t("secretCard.stopped", { label: secret.label })} />;
  }

  if (provided || declined) {
    const retry = !secret.resumed && !stopped && error ? (
      <button type="button" onClick={() => void retryResume()} disabled={saving} className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
        {saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {t("secretCard.tryAgain")}
      </button>
    ) : undefined;
    const status = declined
      ? t("secretCard.cancelled", { label: secret.label })
      : t(secret.kept === "once" ? "secretCard.usedOnce" : "secretCard.saved", { label: secret.label });
    return (
      <SecretSettledRow
        label={secret.label}
        tone={error && !secret.resumed && !stopped ? "failed" : declined ? "off" : "done"}
        title={description}
        status={status}
        action={retry}
        detail={error && <span role="alert" className="mt-1 block text-[13px] leading-[18px] text-danger">{t("secretCard.resumeFailed")}: {error}</span>}
      />
    );
  }

  const submit = cardPrimary();
  const note = !custom ? t("secretCard.ref") : email ? t("secretCard.email") : login ? t("secretCard.login") : secret.delivery === "file" ? t("secretCard.file") : t("secretCard.ref");
  return (
    <AskCard
      ariaLabel={secret.label}
      source={{ icon: <Icon name="key" size={12} />, label: t("secretCard.title") }}
      title={secret.label}
      explanation={description}
      onDismiss={dismiss}
      dismissLabel="Not now"
      quiet
    >
      {onlyOnHost ? (
        <div className="text-[13px] leading-relaxed text-ink-secondary">
          This key must be saved on the host computer. Open this conversation on the host to continue securely.
        </div>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          {email && (
            <div className="mb-2 flex flex-col gap-2">
              <input type="email" autoComplete="off" spellCheck={false} dir="ltr" value={address} onChange={(event) => setAddress(event.target.value)} placeholder={t("secretCard.emailAddress")} disabled={saving} aria-label={t("secretCard.emailAddress")} className={cn(CARD_FIELD, "w-full")} />
              {needsServer && <EmailServerInputs value={server} onChange={setServer} className={cn(CARD_FIELD, "w-full")} />}
            </div>
          )}
          {login && (
            <input type="text" name="username" autoComplete="off" spellCheck={false} dir="ltr" value={username} onChange={(event) => setUsername(event.target.value)}
              placeholder={t("secretCard.username")} disabled={saving} aria-label={t("secretCard.username")} maxLength={512} className={cn(CARD_FIELD, "mb-2 w-full")} />
          )}
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            dir="ltr"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={login ? t("secretCard.password") : secret.placeholder}
            disabled={saving || savedLocally}
            aria-label={login ? t("secretCard.password") : secret.label}
            className={cn(CARD_FIELD, "w-full")}
          />
          {login && (
            <input type="password" name="totp" autoComplete="off" spellCheck={false} dir="ltr" value={totp} onChange={(event) => setTotp(event.target.value)}
              placeholder={t("logins.totp")} disabled={saving} aria-label={t("logins.totp")} title={t("logins.totpHint")} maxLength={2048} className={cn(CARD_FIELD, "mt-2 w-full")} />
          )}
          {((custom && !email) || secret.helpUrl) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-4 text-ink-tertiary">
              {custom && !email && (
                <label className="inline-flex cursor-pointer items-center gap-2 text-ink-secondary pointer-coarse:min-h-11" data-secret-remember="">
                  <Toggle checked={remember} disabled={saving} onClick={() => setRemember((on) => !on)} />
                  {t("secretCard.saveToVault")}
                </label>
              )}
              {secret.helpUrl && (
                <a href={secret.helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline">
                  Where to get this key <ExternalLink size={11} />
                </a>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-2 text-[13px] leading-[18px] text-danger">{error}</p>}
          <div className="mt-4 flex items-center gap-3">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] leading-4 text-ink-tertiary">
              <LockKeyhole size={12} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">{note}</span>
            </span>
            <button type="submit" disabled={saving || (!value.trim() && !savedLocally) || (email && !address.trim())} className={submit.className} style={submit.style}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              {savedLocally ? "Continue task" : custom ? t("secretCard.submit") : "Save securely"}
            </button>
          </div>
        </form>
      )}
      {onlyOnHost && error && <p role="alert" className="mt-2 text-[13px] leading-[18px] text-danger">{error}</p>}
    </AskCard>
  );
}
