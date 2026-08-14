import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CertificatePair = {
  certificate: string;
  key: string;
};

export type MutualTlsAuthority = {
  directory: string;
  ca: string;
  server: CertificatePair;
  client: CertificatePair;
  wrongClient: CertificatePair;
  cleanup(): Promise<void>;
};

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "-");

export const generateMutualTlsAuthority = async (input: {
  name: string;
  serverName: string;
  clientCommonName: string;
}): Promise<MutualTlsAuthority> => {
  const name = safeName(input.name);
  const directory = await mkdtemp(join(tmpdir(), `lemmacomputer-${name}-mtls-`));
  const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });

  openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", "ca.key", "-out", "ca.crt",
    "-subj", `/CN=lemmacomputer-${name}-test-ca`, "-days", "1",
  ]);

  let serial = 1000;
  const issue = async (fileName: string, commonName: string, usage: "serverAuth" | "clientAuth", subjectAltName?: string): Promise<CertificatePair> => {
    openssl([
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", `${fileName}.key`, "-out", `${fileName}.csr`,
      "-subj", `/CN=${commonName}`,
    ]);
    const extensions = [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      `extendedKeyUsage=${usage}`,
      ...(subjectAltName ? [`subjectAltName=DNS:${subjectAltName}`] : []),
    ].join("\n");
    await writeFile(join(directory, `${fileName}.ext`), `${extensions}\n`, { mode: 0o600 });
    openssl([
      "x509", "-req", "-in", `${fileName}.csr`,
      "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", String(serial++),
      "-out", `${fileName}.crt`, "-days", "1", "-extfile", `${fileName}.ext`,
    ]);
    return {
      certificate: await readFile(join(directory, `${fileName}.crt`), "utf8"),
      key: await readFile(join(directory, `${fileName}.key`), "utf8"),
    };
  };

  try {
    return {
      directory,
      ca: await readFile(join(directory, "ca.crt"), "utf8"),
      server: await issue("server", input.serverName, "serverAuth", input.serverName),
      client: await issue("control", input.clientCommonName, "clientAuth"),
      wrongClient: await issue("foreign-workload", "foreign-workload", "clientAuth"),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};
