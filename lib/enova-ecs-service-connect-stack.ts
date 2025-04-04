import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import path = require('path');

export class EnovaEcsServiceConnectStack extends cdk.Stack {

  readonly logGroup: cdk.aws_logs.LogGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  
    // Create a new Vpc without NAT Gateway
  //  const vpc = new ec2.Vpc(this, "Vpc", {
  //    ipAddresses: ec2.IpAddresses.cidr('172.30.0.0/16'),
  //    maxAzs: 2,
  //    natGateways: 0,
  //    subnetConfiguration: [
  //      {
  //        name: 'public',
  //        subnetType: ec2.SubnetType.PUBLIC,
  //        cidrMask: 24
  //      },
  //      {
  //        name: 'isolated',
  //        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
  //        cidrMask: 24
  //      }
  //    ]
  //  });

    // set if use existing vpc
    const vpc = Vpc.fromLookup(this, "Vpc", { vpcId: "vpc-xxxxxxxxxxxxxxx" });

    const ecsCluster = new ecs.Cluster(this, "EcsCluster", {
      vpc: vpc,
      clusterName: "enova-cluster",
    });

    const dnsNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "DnsNamespace",
      {
        name: "enova-ecs-service-connect.test",
        vpc: vpc,
      }
    ); 

    this.logGroup = new cdk.aws_logs.LogGroup(this, "LogGroup", {
      logGroupName: "EnovaEcsServiceConnect",
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
      retention: RetentionDays.ONE_WEEK
    });

    // access ECR by endpoint
    new ec2.InterfaceVpcEndpoint(this, 'ECRVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true
    })
    new ec2.InterfaceVpcEndpoint(this, 'ECRDockerVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true
    })
    new ec2.GatewayVpcEndpoint(this, 'S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      vpc,
      subnets: [{ subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED }]
    })

    // access Cloudwatch logging
    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true
    })


    // backend - deploy Soneta Server.Standard
    const appPorts = [{ portMappingName: "enova-server", port: 22000 }];

    const enovaServerTaskDefinition = this.buildTaskDefinition("enova-server", "server", appPorts);

    const enovaserverservice = new ecs.FargateService(this, "enova-server-service", {
      cluster: ecsCluster, 
      desiredCount: 1, 
      serviceName: "enova-server",
      taskDefinition: enovaServerTaskDefinition,
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED
      },
      serviceConnectConfiguration: {
        services: appPorts.map(({ portMappingName, port }) => ({
          portMappingName,
          dnsName: portMappingName,
          port,
        })),
        namespace: dnsNamespace.namespaceName,
      },
      enableExecuteCommand: true
    });

    // frontend - deploy Soneta WebServer.Standard
    const webPorts = [{ portMappingName: "enova-web", port: 8080 }];
        
    const enovaWebTaskDefinition = this.buildTaskDefinition("enova-web", "web", webPorts);

    const enovawebservice = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "enova-web-service", {
      cluster: ecsCluster, 
      desiredCount: 1, 
      publicLoadBalancer: true, 
      serviceName: "enova-web",
      taskDefinition: enovaWebTaskDefinition,
      enableExecuteCommand: true
    });

    // Have to do this separate because ApplicationLoadBalancedFargateService doesn't support service connect
    enovawebservice.service.enableServiceConnect({
      namespace: dnsNamespace.namespaceName,
    })

    enovawebservice.node.addDependency(dnsNamespace)
    enovaserverservice.node.addDependency(dnsNamespace) 

    enovaserverservice.connections.allowFrom(enovawebservice.service, ec2.Port.tcp(22000))
 
  }

  buildTaskDefinition = (appName: string, dockerfile: string, portMappings: { portMappingName: string, port: number }[]) => {
  
      const taskdef = new ecs.FargateTaskDefinition(this, `${appName}-taskdef`, {
      memoryLimitMiB: 2048, 
      cpu: 512,
    });

    const container = taskdef.addContainer(`${appName}`, {
    //  image: ecs.ContainerImage.fromRegistry(dockerImage),
      image: ecs.ContainerImage.fromAsset(path.resolve(__dirname, dockerfile)),
      logging: ecs.LogDrivers.awsLogs({ 
        logGroup: this.logGroup,
        streamPrefix: `service`
      })
    });

    portMappings.forEach(({ port, portMappingName }) =>
      container.addPortMappings({ containerPort: port, name: portMappingName})
    );

    taskdef.executionRole?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"))

    return taskdef
  }
}
