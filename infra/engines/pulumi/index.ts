// Tenant de Asistencia con Pulumi: red aislada por grupos de seguridad + 3 VMs (frontend, backend, BD).
// Misma arquitectura y mismo catálogo de planes que infra/modules/tenant (OpenTofu/Terraform).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const cfg = new pulumi.Config();
const tenant = cfg.require("tenant");
const plan = cfg.get("plan") ?? "basic";
const environment = cfg.get("environment") ?? "prod";
const amiId = cfg.get("amiId");
const adminCidr = cfg.get("adminCidr") ?? "0.0.0.0/0";
const keyPath = (cfg.get("sshPublicKeyPath") ?? "~/.ssh/diplo_mod2_key.pub").replace(/^~/, os.homedir());

// Catálogo de planes: debe coincidir con docs/catalogo-de-planes.md
const plans: Record<string, { appType: string; dbType: string; appDisk: number; dbDisk: number }> = {
  basic:    { appType: "t3.micro",  dbType: "t3.micro",  appDisk: 10, dbDisk: 10 },
  standard: { appType: "t3.small",  dbType: "t3.small",  appDisk: 20, dbDisk: 20 },
  advanced: { appType: "t3.medium", dbType: "t3.medium", appDisk: 30, dbDisk: 50 },
};
const p = plans[plan];
if (!p) throw new Error(`Plan inválido: ${plan}`);
const name = `tenant-${tenant}`;
const tags = { Project: "capa8-asistencia", Tenant: tenant, Plan: plan, Env: environment, ManagedBy: "pulumi" };

const vpc = aws.ec2.getVpcOutput({ default: true });
const ami = amiId
  ? pulumi.output(amiId)
  : aws.ec2.getAmiOutput({ mostRecent: true, owners: ["099720109477"], filters: [{ name: "name", values: ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"] }] }).id;
const monitoringCidr = cfg.get("monitoringCidr") ?? vpc.cidrBlock;

const key = new aws.ec2.KeyPair(`${name}-key`, { keyName: `${name}-key`, publicKey: fs.readFileSync(keyPath, "utf-8").trim() });

const egress = [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }];
const ssh = { description: "SSH admin", protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: [adminCidr] };
const exporter = { description: "node_exporter", protocol: "tcp", fromPort: 9100, toPort: 9100, cidrBlocks: [monitoringCidr] };

const frontendSg = new aws.ec2.SecurityGroup(`${name}-frontend`, {
  name: `${name}-frontend`, description: "HTTP publico + SSH admin", vpcId: vpc.id, tags,
  ingress: [{ description: "HTTP", protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] }, ssh, exporter], egress,
});
const backendSg = new aws.ec2.SecurityGroup(`${name}-backend`, {
  name: `${name}-backend`, description: "API solo desde el frontend + SSH admin", vpcId: vpc.id, tags,
  ingress: [{ description: "API NestJS solo desde el frontend del tenant", protocol: "tcp", fromPort: 3000, toPort: 3000, securityGroups: [frontendSg.id] }, ssh, exporter], egress,
});
const dbSg = new aws.ec2.SecurityGroup(`${name}-db`, {
  name: `${name}-db`, description: "PostgreSQL solo desde el backend del tenant", vpcId: vpc.id, tags,
  ingress: [{ description: "PostgreSQL solo desde el backend del tenant", protocol: "tcp", fromPort: 5432, toPort: 5432, securityGroups: [backendSg.id] }, ssh, exporter], egress,
});

const cloudInit = (role: string) => `#cloud-config
hostname: ${tenant}-${role}
manage_etc_hosts: true
package_update: true
packages: [python3, python3-apt, prometheus-node-exporter]
write_files:
  - path: /etc/tenant.env
    permissions: "0644"
    content: |
      TENANT_ID=${tenant}
      ROLE=${role}
      ENVIRONMENT=${environment}
      PLAN=${plan}
runcmd:
  - systemctl enable --now prometheus-node-exporter
`;

function vm(role: string, type: string, disk: number, sg: aws.ec2.SecurityGroup) {
  return new aws.ec2.Instance(`${name}-${role}`, {
    ami, instanceType: type, keyName: key.keyName, vpcSecurityGroupIds: [sg.id],
    metadataOptions: { httpTokens: "required" },
    rootBlockDevice: { volumeSize: disk, volumeType: "gp3", encrypted: true },
    userData: cloudInit(role),
    tags: { ...tags, Name: `${name}-${role}`, Role: role },
  });
}
const db = vm("db", p.dbType, p.dbDisk, dbSg);
const backend = vm("backend", p.appType, p.appDisk, backendSg);
const frontend = vm("frontend", p.appType, p.appDisk, frontendSg);

// IP fija: la URL del tenant no cambia al suspender/reanudar
const eip = new aws.ec2.Eip(`${name}-frontend`, { domain: "vpc", instance: frontend.id, tags: { ...tags, Name: `${name}-frontend` } });

export const url = pulumi.interpolate`http://${eip.publicIp}`;
export const frontendPublicIp = eip.publicIp;
export const backendPublicIp = backend.publicIp;
export const dbPublicIp = db.publicIp;
export const dbPrivateIp = db.privateIp;
export const backendPrivateIp = backend.privateIp;
export const frontendPrivateIp = frontend.privateIp;
