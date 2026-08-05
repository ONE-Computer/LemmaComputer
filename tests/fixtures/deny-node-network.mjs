import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const denied = () => {
  throw new Error("Network access is denied by the deployment-profile smoke");
};

dns.lookup = denied;
http.get = denied;
http.request = denied;
https.get = denied;
https.request = denied;
net.connect = denied;
net.createConnection = denied;
tls.connect = denied;
globalThis.fetch = denied;
