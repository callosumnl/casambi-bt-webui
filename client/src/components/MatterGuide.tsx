import { ExternalLink } from "lucide-react";
import { Modal } from "@/components/Modal";
import { t } from "@/lib/i18n";
import { formatId } from "@/lib/matter";

const DEVELOPER_CONSOLE = "https://console.home.google.com";
const GOOGLE_HELP = "https://support.google.com/googlehome/answer/13127223";

/** Step-by-step instructions for connecting Google Home, with the vendor and product id this bridge uses. */
export function MatterGuide({ open, onClose, vendorId, productId }: { open: boolean; onClose: () => void; vendorId: number; productId: number }) {
  const link = (href: string, label: string) => <a className="outline-button guide-link" href={href} target="_blank" rel="noopener noreferrer"><ExternalLink /> {label}</a>;
  return <Modal open={open} onClose={onClose} title={t("CONNECT GOOGLE HOME IN 5 STEPS")}>
    <p className="muted-copy">{t("Once, about 10 minutes. You need a Google Nest speaker or display, the Google Home app on your phone, and the Google account you use in that app.")}</p>
    <ol className="guide-steps">
      <li><strong>{t("Create a free developer project")}</strong>
        <p>{t("Open the Google Home Developer Console and sign in with the same Google account as your Google Home app. Accept the terms and create a project; any name will do, for example \"Casambi\".")}</p>
        {link(DEVELOPER_CONSOLE, t("OPEN THE DEVELOPER CONSOLE"))}
      </li>
      <li><strong>{t("Add a Matter integration")}</strong>
        <p>{t("In the project, add an integration and choose Matter. Pick a device type (Light, or Bridge when it is offered), the test vendor id, and this product id, then save:")}</p>
        <p className="guide-values"><span>{t("Vendor ID")} <code>{formatId(vendorId)}</code></span><span>{t("Product ID")} <code>{formatId(productId)}</code></span></p>
        <p className="muted-copy">{t("The console's screens can look a little different; what matters is that both ids match.")}</p>
      </li>
      <li><strong>{t("Turn on the bridge here")}</strong>
        <p>{t("Tick RUN THE MATTER BRIDGE in this tab and save. A QR code and a setup code appear.")}</p>
      </li>
      <li><strong>{t("Add it in the Google Home app")}</strong>
        <p>{t("Tap + → Device → Matter device and scan the QR code (or type the setup code). Accept the warning about an uncertified device and choose a room. Preparing the device can take a few minutes.")}</p>
        {link(GOOGLE_HELP, t("GOOGLE'S HELP ON MATTER DEVICES"))}
      </li>
      <li><strong>{t("Give the lamps a room")}</strong>
        <p>{t("Lamps of a bridge can end up under \"Not in a room\". Open a lamp, tap the gear, and choose its room. Then try: \"Hey Google, zet de leeslamp aan\".")}</p>
      </li>
    </ol>
    <p className="muted-copy">{t("Paired with an iPhone? Keep \"iPhone (Apple keychain)\" in the list of connected apps: removing it can disconnect Google Home too.")}</p>
    <p className="muted-copy">{t("Google Home cannot find the bridge? The phone and the Nest must be on the same network as the Pi; the System check shows whether the bridge runs and the Pi has IPv6.")}</p>
  </Modal>;
}
