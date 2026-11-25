/** The logic layer runs in its own Worker, apart from every page's view, as on WeChat. */
import { startLogic, type ShellToLogic } from "@omr/runtime";

// The shell's first message hands over a private port, before any Mini Program code runs.
// That code shares this Worker: it can post on the Worker itself, which the shell ignores,
// but it has no reference to the port, so it can neither speak for the logic layer nor
// answer a system dialog such as phone number consent for the user.
const onConnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  self.removeEventListener("message", onConnect);
  const send = port.postMessage.bind(port);
  const handle = startLogic((message) => send(message));
  port.addEventListener("message", (message: MessageEvent<ShellToLogic>) => {
    if (message.isTrusted) handle(message.data);
  });
  port.start();
};
self.addEventListener("message", onConnect);
