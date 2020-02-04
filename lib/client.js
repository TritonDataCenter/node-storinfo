/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

const EventEmitter = require('events').EventEmitter;

const assert = require('assert-plus');
const bunyan = require('bunyan');
const cueball = require('cueball');
const errors = require('./errors.js');
const once = require('once');
const restify = require('restify');
const uri = require('urijs');
const util = require('util');

const sprintf = util.format;

const DEF_NUM_COPIES = 2;
const DEF_MAX_STREAMING_SIZE_MB = 5120;
const DEF_MAX_PERCENT_UTIL = 90;
const DEF_MAX_OPERATOR_PERCENT_UTIL = 92;

/*
 * Fisher-Yates shuffle - courtesy of http://bost.ocks.org/mike/shuffle/
 *
 * Called by StorinfoClient.choose()
 */
function shuffle(array) {
    var m = array.length, t, i;

    while (m) {
        i = Math.floor(Math.random() * m--);
        t = array[m];
        array[m] = array[i];
        array[i] = t;
    }
    return (array);
}

/*
 * Just picks a random number, and optionally skips the last one we saw.
 *
 * Called by StorinfoClient.choose()
 */
function random(min, max, skip) {
    var num = (Math.floor(Math.random() * (max - min + 1)) + min);

    if (num === skip)
        num = ((num + 1) % max);

    return (num);
}

/*
 * Modified binary-search. We're looking for the point in the set at which all
 * servers have at least the requested amount of space.  Logically you would
 * then do set.slice(lower_bound(set, 100));
 * But that creates a copy - but really the return value of this to $end is
 * what the choose logic can then look at.
 *
 * Called by StorinfoClient.choose()
 */
function lower_bound(set, size, low, high) {
    assert.arrayOfObject(set, 'set');
    assert.number(size, 'size');
    assert.optionalNumber(low, 'low');

    low = low || 0;
    high = high || set.length;

    while (low < high) {
        var mid = Math.floor(low + (high - low) / 2);
        if (set[mid].availableMB >= size) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    if (!set[low] || set[low].availableMB < size)
        low = -1;

    return (low);
}

/*
 * A comparison function used to order storage zones based on available space.
 *
 * @param {object} a               - a storage zone object
 * @param {integer} a.availableMB  - free space in MB on the storage zone
 * @param {object} b               - a storage zone object
 * @param {integer} b.availableMB  - free space in MB on the storage zone
 * @throws {TypeError} on bad input.
 */
function storageZoneComparator(a, b) {
    assert.object(a, 'a');
    assert.object(b, 'b');
    assert.number(a.availableMB, 'a.availableMB');
    assert.number(b.availableMB, 'b.availableMB');

    if (a.availableMB < b.availableMB) {
        return (-1);
    } else if (a.availableMB > b.availableMB) {
        return (1);
    }

    return (0);
}

/*
 * A function to sort the storage zones available for normal requests and those
 * available only for operator requests within each datacenter by available
 * storage.
 *
 * @param {object} dcObj   - an object mapping datacenters to their associated
 *                           storage zones
 * @param {object} opDcObj - an object mapping datacenters to their associated
 *                           storage zones
 * @throws {TypeError} on bad input.
 */
function sortAndStoreDcs(dcObj, opDcObj) {
    assert.object(dcObj, 'dcObj');
    assert.object(opDcObj, 'opDcObj');

    var dcCount = 0;
    var operatorDcCount = 0;
    var dcs = Object.keys(dcObj);
    var operatorDcs = Object.keys(opDcObj);

    dcs.forEach(function dcSortAndCount(k) {
        dcObj[k].sort(storageZoneComparator);
        dcCount++;
    });

    operatorDcs.forEach(function opDcSortAndCount(k) {
        opDcObj[k].sort(storageZoneComparator);
        operatorDcCount++;
    });

    if (dcCount > 0) {
        this.datacenters = dcs;
    } else {
        this.log.warn('sortAndStoreDcs: could not find any minnow ' +
            'instances');
        this.datacenters = [];
    }

    if (operatorDcCount > 0) {
        this.operatorDatacenters = operatorDcs;
    } else {
        this.log.warn('sortAndStoreDcs: could not find any minnow ' +
            'instances for operator requests');
        this.operatorDatacenters = [];
    }

    this.dcSharkMap = dcObj;
    this.operatorDcSharkMap = opDcObj;
    this.emit('topology', [this.dcSharkMap, this.operatorDcSharkMap]);

    this.log.trace('sortAndStoreDcs: done');
}

function doPoll() {
    clearTimeout(this.pollTimer);

    var self = this;
    var args = {};

    self.poll(args, function (res, err) {
        if (err) {
            this.log.error(err, 'doPoll: unexpected error ' +
                '(will retry)');
            return;
        }
        this.pollTimer = setTimeout(doPoll.bind(self), self.pollInterval);

        var dcObj = {};
        var opDcObj = {};

        function sortByDatacenter(maxUtilization, v) {
            if (!opDcObj[v.datacenter]) {
                opDcObj[v.datacenter] = [];
            }

            /*
             * The Storinfo service's /poll interface already filters out
             * storage nodes who's utilization is above the operator
             * threshold.
             */
            opDcObj[v.datacenter].push(v);

            /*
             * Moray is queried for the sharks whose utilization is less than
             * or equal to the maximum utilization percentage at which operator
             * writes are still accepted. Find the set of sharks whose
             * utilization is less than or equal to the utilization threshold
             * for all requests.
             */
            if (v.percentUsed <= maxUtilization) {
                if (!dcObj[v.datacenter]) {
                    dcObj[v.datacenter] = [];
                }

                dcObj[v.datacenter].push(v);
            }
        }

        res.forEach(sortByDatacenter.bind(self, self.utilization));

        /*
         * We just defer to the next tick so we're not tying
         * up the event loop to sort a lot if the list is large
         */
        setImmediate(sortAndStoreDcs.bind(self, dcObj, opDcObj));
    });
}

/*
 * url: storinfo service URL
 * cueballOpts: object containing required cueball options
 */
function StorinfoClient(opts) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'log');
    assert.optionalNumber(opts.pollInterval, 'pollInterval');
    assert.optionalBool(opts.multiDC, 'multiDC');
    assert.optionalNumber(opts.defaultMaxStreamingSizeMB,
        'defaultMaxStreamingSizeMB');
    assert.optionalNumber(opts.maxUtilizationPct, 'maxUtilizationPct');
    assert.bool(opts.standalone, 'standalone');

    this.log = opts.log || bunyan.createLogger({ name: 'storinfo' });

    /*
     * If we're not running in standalone mode, create the restify client.
     */
    if (!opts.standalone) {
        assert.string(opts.url, 'url');
        assert.object(opts.cueballOpts, 'cueballOpts');

        opts.cueballOpts.log = this.log;
        var clientOpts = {
            url: opts.url,
            agent: new cueball.HttpAgent(opts.cueballOpts),
            log: this.log
        };

        this.http = restify.createJsonClient(clientOpts);
    }
    this.standalone = opts.standalone;

    EventEmitter.call(this);

    /*
     * The dcSharkMap is an object that maps datacenter names to an array of
     * sharks sorted by available storage capacity that are all at or below the
     * storage utilization threshold for normal manta requests.
     */
    this.dcSharkMap = null;
    /*
     * The operatorDcSharkMap is an object that maps datacenter names to an
     * array of sharks sorted by available storage capacity that are all at or
     * below the storage utilization threshold for operator manta requests.
     */
    this.operatorDcSharkMap = null;

    this.dcIndex = -1;
    this.multiDC = opts.multiDC === undefined ? true : opts.multiDC;
    this.datacenters = null;

    if (opts.pollInterval !== undefined && !opts.standalone) {
        this.pollInterval = (opts.pollInterval * 1000);
        this.defMaxSizeMB = opts.defaultMaxStreamingSizeMB ||
            DEF_MAX_STREAMING_SIZE_MB;
        this.utilization = opts.maxUtilizationPct ||
            DEF_MAX_PERCENT_UTIL;
        setImmediate(doPoll.bind(this));
    }
}
util.inherits(StorinfoClient, EventEmitter);

StorinfoClient.prototype.close = function close() {
    if (this.pollTimer) {
        clearTimeout(this._storageTimer);
    }
    if (! this.standalone) {
        this.http.close();
    }
};

/*
 * Get the data for a specific row (storage node) from the manta_storage bucket.
 * This takes a single required argument, which is the manta_storage_id of the
 * storage node.
 *
 * On success, the "err" parameter to the callback will be null and the "obj"
 * param will contain manta_storage object for the requested storage node.
 *
 * On failure, the "obj" param will be set to null.
 */
StorinfoClient.prototype.pollSpecific = function pollSpecific(storageid,
    callback) {

    assert.string(storageid, 'storageid');

    /*
     * pollSpecific isn't supported in standalone mode
     */
    if (this.standalone) {
        var standErr = new errors.StandaloneModeError();
        callback(null, standErr);
    }

    this.http.get('/poll?only_id=' + storageid, function (err, req, res, obj) {
        if (err) {
            callback(null, err);
        }
        callback(obj, null);
    });
};

/*
 * This function wraps the /poll API provided by the Manta Storinfo service.
 * It takes two arguemnts:
 *   args: object containing the following properties
 *       uriParams: optional object containing the following optional params:
 *           after_id: String manta_storage_id
 *           limit: Number
 *
 *       The args object is also used internally to store the intermiediate and
 *       final results of successive calls to /poll.
 *
 *   callback: callback function that will take two parameters
 *       res: on success, this will contain the response from /poll
 *            on error, this will be null
 *       err: object containing error details if an error occurs
 *            on success, this param will be null
 */
StorinfoClient.prototype.poll = function poll(args, callback) {
    assert.object(args, 'args');
    assert.optionalObject(args.uriParams);

    var self = this;

    /*
     * poll isn't supported in standalone mode
     */
    if (self.standalone) {
        var standErr = new errors.StandaloneModeError();
        callback(null, standErr);
    }

    var query = uri.buildQuery(args.uriParams);
    if (args.res === undefined) {
        args.res = [];
    }

    this.http.get('/poll?' + query, function (err, req, res, obj) {
        if (err) {
            callback(null, err);
        }
        Array.prototype.push.apply(args.res, obj);
        if (res.headers.link !== undefined) {
            /*
             * The format of the 'link' is:
             * </poll?after_id=storageid&limiit=number>; rel=\"next\"
             *
             * we extract the after_id parameter
             */
            args.uriParams.after_id =
                res.headers.link.split('=')[1].split('&')[0];
            self.poll(args, function (r, e) {
                callback(args.res, e);
            });
        } else {
            callback(args.res, err);
        }
    });
};


/*
 * Selects N shark nodes from sharks with more space than the request length.
 *
 * @param {object} options -
 *                   - {number} size => req.getContentLength()
 *                   - {number} replicas => req.header('x-durability-level')
 *                   - {boolean} isOperator => req.caller.account.isOperator
 * @param {funtion} callback => f(err, [sharkClient])
 *
 * Choose takes a desired number of replicas and a size (in bytes), and then
 * selects three random "tuples" (the number of items in a tuple is
 * #replicas).  The first random tuple is "primary," and then we have 2 backup
 * tuples.  The contract here is that upstack code tries all hosts in
 * "primary," and if all are up we're good to go; if any fail it falls through
 * to trying all hosts in "secondary." While not the most sophisticated and/or
 * error-proof approach, this is simple to reason about, and should be "good
 * enough," given what we know about our infrastructure (i.e., we expect it to
 * be up).
 *
 * So in terms of implementation, Storinfo periodically refreshes a (sorted) set
 * of servers per datacenter that is advertised in a moray bucket
 * (manta_storage).  To see how data gets in manta_storage, see minnow.git.
 *
 * So conceptually it looks like this:
 *
 * {
 *   us-east-1: [a, b, c, ...],
 *   us-east-2: [d, e, f, ...],
 *   us-east-3: [g, h, i, ...],
 *   ...
 * }
 *
 * Where the objects `a...N` are the full JSON representation of a single mako
 * instance.  In that object, we really only care about two fields:
 *
 *   -- manta_storage_id (hostname)
 *   -- availableMB
 *
 * We keep those sets sorted by `availableMB`, and everytime choose is run, we
 * make a "view" of the set for each data center that tells us all the servers
 * that have that amount of storage and larger (binary search).
 *
 * Once we have that "view," we simply pick random nodes from the set(s).
 * Lastly, we RR across DCs so we spread objects around evenly.
 */
StorinfoClient.prototype.choose = function choose(opts, cb) {
    assert.object(opts, 'options');
    assert.optionalObject(opts.log, 'options.log');
    assert.optionalNumber(opts.replicas, 'options.replicas');
    assert.optionalNumber(opts.size, 'options.size');
    assert.optionalBool(opts.isOperator, 'options.isOperator');
    assert.func(cb, 'callback');

    cb = once(cb);

    var dcs = [];
    var log = this.log;
    var offsets = [];
    var replicas = opts.replicas || DEF_NUM_COPIES;
    var seen = [];
    var self = this;
    var size = Math.ceil((opts.size || 0) / 1048576) || this.defMaxSizeMB;
    var err, cause;

    log.debug({
        replicas: replicas,
        size: size,
        defMaxSizeMB: this.defMaxSizeMB
    }, 'StorinfoClient.choose: entered');

    /*
     * Determine the index of the first storage node for each DC that has space
     * for an object of the requested size.  If no sharks in a given DC have
     * enough space, we exclude them from the possible set of DCs to choose
     * from.
     */
    function filterDatacenters(sharkMap, dc) {
        var l = lower_bound(sharkMap[dc], size);
        if (l !== -1) {
            dcs.push(dc);
            offsets.push(l);
        }
    }

    var filterFun;

    if (opts.isOperator) {
        filterFun = filterDatacenters.bind(this, this.operatorDcSharkMap);
        this.operatorDatacenters.forEach(filterFun);
    } else {
        filterFun = filterDatacenters.bind(this, this.dcSharkMap);
        this.datacenters.forEach(filterFun);
    }

    var chooseStats = {
        db: opts.isOperator ? self.operatorDcSharkMap : self.dcSharkMap,
        dcsInUse: dcs,
        offsets: offsets
    };

    var enoughDCs = false;
    if (dcs.length === 0) {
        cause = sprintf('no DC with sufficient space');
    } else if (replicas > 1 && this.multiDC && dcs.length < 2) {
        cause = sprintf('%d copies requested, but only %d DC(s) have ' +
            'sufficient space', replicas, dcs.length);
    } else {
        enoughDCs = true;
    }

    if (!enoughDCs) {
        log.warn('StorinfoClient.choose: not enough DCs available');
        assert.string(cause, 'no error message set');

        err = new errors.NotEnoughSpaceError(size, cause);
        cb(err, null, chooseStats);
        return;
    }

    dcs = shuffle(dcs);

    /*
     * Pick a random shark from the next DC in the round robin ordering.  If it
     * hasn't yet been used for a set, return the shark.
     *
     * If the shark has been chosen for another set, iterate through all sharks
     * in the DC until we find one that hasn't yet been seen.
     *
     * If there are no sharks that haven't yet been used in the DC, return null.
     */
    function host() {
        if (++self.dcIndex >= dcs.length)
            self.dcIndex = 0;

        var ndx = self.dcIndex;
        var dc;
        if (opts.isOperator) {
            dc = self.operatorDcSharkMap[dcs[ndx]];
        } else {
            dc = self.dcSharkMap[dcs[ndx]];
        }

        var s = random(offsets[ndx], dc.length - 1);

        if (seen.indexOf(dc[s].manta_storage_id) === -1) {
            seen.push(dc[s].manta_storage_id);
        } else {
            var start = s;
            do {
                if (++s === dc.length)
                    s = offsets[ndx];

                if (s === start) {
                    log.debug({
                        datacenter: dcs[ndx]
                    }, 'StorinfoClient.choose: exhausted DC');
                    return (null);
                }

            } while (seen.indexOf(dc[s].manta_storage_id) !== -1);

            seen.push(dc[s].manta_storage_id);
        }

        return ({
            datacenter: dc[s].datacenter,
            manta_storage_id: dc[s].manta_storage_id
        });
    }

    /*
     * Return a set with `replicas` sharks.
     */
    function set() {
        var s = [];

        for (var j = 0; j < replicas; j++) {
            var _s = host();
            if (_s === null)
                return (null);
            s.push(_s);
        }

        return (s);
    }

    /*
     * We always pick three sets, and we pedantically ensure that we've got
     * them splayed x-dc
     */
    var sharks = [];
    for (var i = 0; i < 3; i++) {
        var tuple = set();

        if (!sharks.length && (!tuple || tuple.length < replicas)) {
            cause = 'copies requested exceeds number of available ' +
                'storage nodes';
            err = new errors.NotEnoughSpaceError(size, cause);
            cb(err, null, chooseStats);
            return;
        } else if (tuple && this.multiDC && replicas > 1) {
            function mapFun(s) {
                return (s.datacenter);
            }

            function reduceFun(last, now) {
                if (last.indexOf(now) === -1) {
                    last.push(now);
                }

                return (last);
            }

            var _dcs = tuple.map(mapFun).reduce(reduceFun, []);

            if (_dcs.length < 2) {
                cause = 'insufficient number of DCs selected';
                err = new errors.NotEnoughSpaceError(size, cause);
                cb(err, null, chooseStats);
                return;
            }
        }

        if (tuple)
            sharks.push(tuple);
    }

    log.debug({
        replicas: replicas,
        sharks: sharks,
        size: size
    }, 'StorinfoClient.choose: done');
    cb(null, sharks, chooseStats);
};


module.exports = {
    StorinfoClient: StorinfoClient,
    createClient: function (opts) {
        return (new StorinfoClient(opts));
    },
    sortAndStoreDcs: sortAndStoreDcs
};
