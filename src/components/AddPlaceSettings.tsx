import { useState } from "react";
import { t } from "@/lib/i18n";
import { buyOfferAllowed, usd } from "@/lib/cloud-plan";
import { usePlaces } from "@/lib/places";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import { useStore } from "@/state/store";
import { NavRow, useSubPage } from "./ListRows";
import { InstallSetup, ServerWays, WaySetup, wayOf } from "./PlaceSetup";
import { useCloudPlan } from "./ProIntroduction";
import { SettingsRows } from "./SettingsPrimitives";
import { ADD_PLACE_PAGE, PLACE_INSTALL_PAGE, PLACE_SERVER_PAGE, PLACE_WAY_PAGE } from "./settings-page-ids";
import { Tag } from "./cloud-buy/parts";
import { PlaceArt } from "./ui/PlaceArt";

export const isAddPlacePage = (at: string | undefined) => at === ADD_PLACE_PAGE || at === PLACE_SERVER_PAGE || at === PLACE_INSTALL_PAGE || Boolean(at?.startsWith(PLACE_WAY_PAGE));

/** Settings → Computer → add a place: madani cloud up front, a server of one's own below it, and that server's whole guided
 * setup on the pages after it. */
export function AddPlacePage() {
  const sub = useSubPage();
  const { dispatch } = useStore();
  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const way = sub.at?.startsWith(PLACE_WAY_PAGE) ? wayOf(sub.at.slice(PLACE_WAY_PAGE.length)) : undefined;
  if (sub.at === PLACE_INSTALL_PAGE) return <div data-settings-block="add-place-install" className="contents"><InstallSetup onClose={close} /></div>;
  if (way) return <div data-settings-block="add-place-way" className="contents"><WaySetup key={way.key} way={way} onClose={close} /></div>;
  if (sub.at === PLACE_SERVER_PAGE) {
    return (
      <div data-settings-block="add-place-server" className="flex flex-col gap-4">
        <ServerWays onPick={(key) => (key === "relay" ? sub.open(PLACE_INSTALL_PAGE, t("placeSetup.relay")) : sub.open(`${PLACE_WAY_PAGE}${key}`, t(wayOf(key)!.title)))} />
      </div>
    );
  }
  return (
    <div data-settings-block="add-place" className="flex flex-col gap-5">
      <CloudWay />
      <SettingsRows>
        <NavRow data-settings-open="add-own-server" pixel="server" title={t("placeSetup.server")} hint={t("placeSetup.serverSub")}
          onClick={() => sub.open(PLACE_SERVER_PAGE, t("placeSetup.server"))} />
      </SettingsRows>
    </div>
  );
}

/** madani cloud: what it gives, what it costs from, and the buying sheet; or the person's own cloud, one click away. */
function CloudWay() {
  const { dispatch } = useStore();
  const rail = usePlaces();
  const plan = useCloudPlan();
  const offer = useCloudOffer(plan !== null && buyOfferAllowed(plan.view), plan?.account?.offer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remote = window.madaniDesktop?.remoteClient?.active === true;
  const mine = rail.places.find((place) => place.kind === "cloud");
  const canBuy = Boolean(window.madaniDesktop?.cloudAccount) && !remote;
  if (!mine && !canBuy) return null;
  const cheapest = offer?.plans.length ? Math.min(...offer.plans.map((entry) => entry.amount)) : null;
  const open = () => {
    const bridge = window.madaniDesktop?.workspaces;
    if (!mine || !bridge?.open || busy) return;
    setBusy(true); setError("");
    void bridge.open(mine.id).catch(() => setError(t("connectedWorkspaces.switchError"))).finally(() => setBusy(false));
  };
  return (
    <section data-add-place="cloud" aria-labelledby="add-place-cloud" className="flex items-start gap-4 rounded-2xl bg-ink/[0.035] p-5">
      <PlaceArt name="cloud" size={44} className="-mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="flex items-center gap-2">
          <h3 id="add-place-cloud" className="text-[15px] font-semibold leading-5 text-ink">{t("pro.name")}</h3>
          {!mine && <Tag>{t("rail.recommended")}</Tag>}
        </span>
        <p className="text-[13px] leading-[18px] text-ink-secondary">{t("placeSetup.cloudSub")}</p>
        {!mine && cheapest !== null && <p data-add-place-price="" className="text-[12px] leading-4 text-ink-secondary">{t("placeSetup.cloudFrom", { price: usd(cheapest / 100) })}</p>}
        <div className="mt-2.5">
          {mine
            ? mine.active
              ? <span className="text-[13px] leading-[18px] text-ink-secondary">{t("connectedWorkspaces.current")}</span>
              : <button type="button" data-settings-open="open-cloud" className="ui-button ui-button-primary" disabled={busy || !mine.opens} onClick={open}>{t("cloudMoveOffer.open")}</button>
            : <button type="button" data-settings-open="get-cloud" className="ui-button ui-button-primary" onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}>{t("rail.buy")}</button>}
        </div>
        {error && <p role="alert" className="text-[13px] leading-[18px] text-danger">{error}</p>}
      </div>
    </section>
  );
}
