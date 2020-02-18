# node-storinfo
This repository is part of the Joyent Manta project.  For contribution guidelines, issues, and general documentation, visit the main [Manta](http://github.com/joyent/manta) project page.

node-storinfo is a NodeJS client for the [Manta Storinfo service](https://github.com/joyent/manta-storinfo).



## Creating a Storinfo Client

node-storinfo supports initializing either a standalone or full StorinfoClient object.  A standalone client does not establish a network connection to the Storinfo service.  It is primarily used for testing the object placement algorithm implemented by the `choose` method without requiring access to an actual Manta deployment.

A standalone client can be created as follows:

``` js
const mod_storinfo = require('storinfo');
           
var client = mod_storinfo.createClient({standalone: true});

```

A full client (one that actually connects to the Storinfo service in a Manta deployment) requires a number of additional properties.

| *property*  | *type* | *description*                                         |
| ----------- | ------ | ----------------------------------------------------- |
| url         | string | URL of Storinfo service                               |
| cueballOpts | object | Required parameters for creating a Cueball HttpAgent. |

For example:

``` js
var opts = {
    standalone: false,
    url: 'http://storinfo.domain'
    cueballOpts: {
        spares: 4,
        maximum: 10,
        recovery: {
            default: {
                timeout: 2000,
                retries: 5,
                delay: 250,
                maxDelay: 1000
            }
        },
        resolvers: ["nameservice.domain"]
    }
};

var client = mod_storinfo.createClient(opts);
```



Additionally, the following _optional_ parameters can be specified when creating a StorinfoClient instance:

| *property*                | *type*  | *description*                                                |
| ------------------------- | ------- | ------------------------------------------------------------ |
| log                       | object  | Bunyan logger.  If specified, node-storinfo will write to this log and also pass it down to cueball and restify.  Otherwise, a new logger will be created. |
| multiDC                   | boolean | Specifies whether the Manta environment contains multiple data centers.  This affects the object placement algorithm implemented by the `choose` method.  In single DC test environments, this can set to false to override the requirement for spreading replicas across DCs.  Default is *false* |
| pollInterval              | number  | If specified, the storinfo client will invoke the GetStorageNodes API for the Storinfo service at the frequency specified by pollInterval.  The value is interpreted as milliseconds.  A 'topology' event will be emitted by the StorinfoClient object after each successful poll. |
| defaultMaxStreamingSizeMB | number  | The maximum allowed size (in MB) for a streaming upload. Default is 5120 MB                                           |
| maxUtilizationPct         | number  | The maximum storage node utilization threshold (as a percentage) for normal (non-operator) object writes.  This affects the object placement algorithm implemened by the `choose` method.  Default is 90.|



## StorinfoClient methods

#### getStorageNodes

The getStorageNodes method returns the Storinfo services cached view of the entire manta_storage bucket, as an array of objects sorted by manta_storage_id.  This method will return an error if invoked on a standalone client.

This asynchronous method takes a the following argument:

| *argument* | *type*   | *description*                                                |
| ---------- | -------- | ------------------------------------------------------------ |
| callback(err, obj) | function | Callback to be invoked upon completion.  The callback will be invoked with two parameters: "res" and "err".  On success, the "err" parameter to the callback will be null and the "res" param will contain an array of for the requested storage node.  On failure, the "res" param will be null and "err" will contain a verror object describing the failure. |



#### getStorageNode

The getStorageNode method returns the Storinfo services cached view of a single row from the manta_storage bucket, corresponding to the storage node with the specified manta_storage_id.   This method will return an error if invoked on a standalone client.

This asynchronous method takes a the following arguments:

| *argument* | *type*   | *description*                                                |
| ---------- | -------- | ------------------------------------------------------------ |
| storageid  | string   | Manta storage ID of the storage node on which to request storage utilization data |
| callback(err, obj) | function | Callback to be invoked upon completion.  The callback will be invoked with two parameters: "obj" and "err".  On success, the "err" parameter to the callback will be null and the "obj param will contain manta_storage object for the requested storage node.  On failure, the "obj" param will be null and "err' willc ontain a verror object describing the failure. |



#### choose

The choose method takes a desired number of replicas and a size (in bytes), and then selects three random "tuples" (the number of items in a tuple is #replicas).  The first random tuple is "primary," and then we have 2 backup tuples.

Conceptually it looks like this:

 ```
{
    us-east-1: [a, b, c, ...],
    us-east-2: [d, e, f, ...],
    us-east-3: [g, h, i, ...],
    ...
}
 ```

Where the objects `a...N` are the full JSON representation of a single storage node.

The choose method can be invoked for both standalone and for StorinfoClient objects.  For non-standalone clients, this method requires that the StorinfoClient has successfully performed at least on poll from the Storinfo service.  This can be assured by either manually calling the `getStorageNodes` method or by specifying the pollInterval property during client creation and then waiting for a 'topology' event.

This method takes the argument object and a callback.  The properties of the argument object are described below:

| *argument* | *type*  | *description*                                                |
| ---------- | ------- | ------------------------------------------------------------ |
| size       | number  | Size of the object (in MB) to be stored.   This is optional and defaults to 5120. |
| replicas   | number  | Number of copies of the object to store (i.e. x-durability-level).  This is optional and defaults to 2. |
| isOperator | boolean | Is this PUT request coming from an operator account?  This is optional and defaults to false. |

## mchoose CLI

This module includes a CLI `bin/mchoose` which provides a scriptable interface for invoking the `getStorageNodes` and `choose` methods.  The usage is described below:

```
Models the behavior of the Manta's object placement logic.

Usage:
    mchoose [OPTIONS] COMMAND [ARGS...]
    mchoose help COMMAND

Options:
    -h, --help      Show this help message and exit.
    --version       Print version and exit.

Commands:
    help (?)        Help on a specific sub-command.
    poll            Poll the Storinfo service for storage records and summarizes the results.
    choose          Simulate Manta storage node selection for an object.
```

## Testing

The automated tests do no require access to a Manta deployment.  They can be run as follows:

```
% make test
```

*NOTE* This module is load-bearing for both the muskie (webapi) and buckets-api MantaV2 services.  Therefore, if you make changes to this node package, you should sanity check the functionality of both services before integration.
