# Pendleton OS ChatGPT Bridge v1

This unpacked Chrome extension captures metadata from the ChatGPT page the user explicitly opens.
It does not receive or store ChatGPT cookies, chat bodies, file contents, or the Pendleton OS
administrator token.

## Install for development

1. Configure `PENDLETON_CHATGPT_BRIDGE_TOKEN` on the Pendleton OS API with a distinct random value of
   at least 32 characters.
2. Apply migration `0006_chatgpt_read_bridge.sql` to the production database and deploy the API.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
4. Open the extension, enter `https://os.peterpendleton.com` and the scoped bridge token.

## Capture workflow

- Open ChatGPT's Projects page and scan it to register the visible project list.
- Open an individual project's Chats tab and scan it to register visible conversations.
- Open the same project's Sources tab and scan it to register visible source metadata.

Each scan is explicit and auditable. Replaying the same snapshot key is idempotent. Download and
import of selected content is deliberately outside the v1 inventory contract.
