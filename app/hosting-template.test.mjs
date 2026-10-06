import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = JSON.parse(readFileSync(new URL('../infra/lightsail.cfn.json', import.meta.url), 'utf8'));
const resources = template.Resources;

test('hosting creates only the own Tokyo host, address, backup bucket and exact game DNS record', () => {
  assert.deepEqual(Object.keys(resources).sort(), ['GameBackupBucket', 'GameDnsRecord', 'GameInstance', 'GameStaticIp']);
  assert.deepEqual(Object.values(resources).map(resource => resource.Type).sort(), [
    'AWS::Lightsail::Bucket', 'AWS::Lightsail::Instance', 'AWS::Lightsail::StaticIp', 'AWS::Route53::RecordSet',
  ]);
  const instance = resources.GameInstance.Properties;
  assert.equal(instance.AvailabilityZone, 'ap-northeast-1a');
  assert.equal(instance.BlueprintId, 'ubuntu_24_04');
  assert.equal(instance.BundleId, 'small_3_0');
  assert.equal(instance.IpAddressType, 'ipv4');
  assert.equal(instance.UserData, undefined);
  const dns = resources.GameDnsRecord.Properties;
  assert.deepEqual(dns.HostedZoneId, { Ref: 'DnsHostedZoneId' });
  assert.deepEqual(dns.Name, { 'Fn::Sub': '${GameDomainName}.' });
  assert.equal(template.Parameters.DnsHostedZoneId.Default, undefined);
  assert.equal(template.Parameters.GameDomainName.Default, undefined);
  const hostPattern = new RegExp(template.Parameters.GameDomainName.AllowedPattern);
  assert.equal(hostPattern.test('game.example.com'), true);
  for (const invalid of ['https://game.example.com', 'game.example.com.', 'game.example.com/path', '-game.example.com', 'localhost', '*.example.com']) {
    assert.equal(hostPattern.test(invalid), false, invalid);
  }
  assert.equal(dns.Type, 'A');
  assert.deepEqual(dns.ResourceRecords, [{ 'Fn::GetAtt': ['GameStaticIp', 'IpAddress'] }]);
  assert.deepEqual(resources.GameStaticIp.Properties.AttachedTo, { Ref: 'GameInstance' });
});

test('hosting limits SSH to an explicit administrator /32 and never exposes Node or general inbound ports', () => {
  const admin = template.Parameters.AdminIpv4Cidr;
  assert.equal(admin.Default, undefined);
  const pattern = new RegExp(admin.AllowedPattern);
  assert.equal(pattern.test('203.0.113.7/32'), true);
  for (const invalid of ['0.0.0.0/0', '203.0.113.0/24', '256.1.2.3/32', '1.2.3.4', '::/0', '1.2.3.4/32\n']) {
    assert.equal(pattern.test(invalid), false, invalid);
  }
  const ports = resources.GameInstance.Properties.Networking.Ports;
  assert.deepEqual(ports.map(port => [port.FromPort, port.ToPort, port.Protocol]), [[80, 80, 'tcp'], [443, 443, 'tcp'], [22, 22, 'tcp']]);
  assert.deepEqual(ports[2].Cidrs, [{ Ref: 'AdminIpv4Cidr' }]);
  assert.ok(ports.every(port => port.Ipv6Cidrs.length === 0 && !port.CidrListAliases));
  assert.equal(template.Parameters.SshKeyPairName.Default, undefined);
  assert.deepEqual(resources.GameInstance.Properties.KeyPairName, { Ref: 'SshKeyPairName' });
});

test('hosting preserves data and leaves backup credentials, client identity and secrets out of infrastructure', () => {
  for (const resource of Object.values(resources)) {
    assert.equal(resource.DeletionPolicy, 'Retain');
    assert.equal(resource.UpdateReplacePolicy, 'Retain');
  }
  const bucket = resources.GameBackupBucket.Properties;
  assert.equal(bucket.BundleId, 'small_1_0');
  assert.equal(bucket.ObjectVersioning, false);
  assert.deepEqual(bucket.AccessRules, { GetObject: 'private', AllowPublicOverrides: false });
  assert.deepEqual(bucket.ResourcesReceivingAccess, [{ Ref: 'GameInstance' }]);
  assert.equal(bucket.ReadOnlyAccessAccounts, undefined);
  assert.deepEqual(resources.GameInstance.Properties.AddOns, [{ AddOnType: 'AutoSnapshot', Status: 'Enabled', AutoSnapshotAddOnRequest: { SnapshotTimeOfDay: '19:00' } }]);
  for (const resource of [resources.GameInstance, resources.GameBackupBucket]) {
    assert.deepEqual(resource.Properties.Tags, [{ Key: 'project', Value: 'game-room' }, { Key: 'env', Value: 'production' }]);
  }
  const serializedProperties = JSON.stringify(Object.values(resources).map(resource => resource.Properties));
  assert.doesNotMatch(serializedProperties, /Cognito|UserPool|ClientId|SecretAccessKey|AccessKeyId|StoreKey|Token|calendar\.|agora\.|stock/i);
  assert.deepEqual(template.Outputs.LoginCallback.Value, { 'Fn::Sub': 'https://${GameDomainName}/auth/callback' });
  assert.deepEqual(template.Outputs.PostLogoutUri.Value, { 'Fn::Sub': 'https://${GameDomainName}/' });
});
