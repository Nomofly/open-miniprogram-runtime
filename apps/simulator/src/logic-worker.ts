/** The logic layer runs in its own Worker, apart from every page's view, as on WeChat. */
import { startLogic, type ShellToLogic } from "@omr/runtime";

// Taken before Mini Program code runs here, so it cannot intercept what the logic layer sends
const postMessage = self.postMessage.bind(self);
const handle = startLogic((message) => postMessage(message));
self.addEventListener("message", (event: MessageEvent<ShellToLogic>) => {
  // Mini Program code shares this Worker; a message it dispatches itself is untrusted,
  // so it cannot answer a system dialog such as phone number consent for the user
  if (event.isTrusted) handle(event.data);
});
