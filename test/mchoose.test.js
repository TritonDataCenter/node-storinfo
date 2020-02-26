/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Test the "mchoose" command.
 */

const forkExecWait = require('forkexec').forkExecWait;
const path = require('path');

const test = require('tap').test;

const BINDIR = path.resolve(__dirname, '../bin');
const MCHOOSE = path.resolve(BINDIR, 'mchoose');


// ---- tests

/*
 * Verify command can be invoked without error
 */
test('mchoose -h', function (t) {
    var argv = [
        MCHOOSE,
        '-h'
    ];

    var usagePhrase =
        'Models the behavior of the Manta\'s object placement logic.';

    forkExecWait({
        argv: argv
    }, function (err, info) {
        t.ifError(err, err);

        t.equal(info.stderr, '', 'no stderr');
        t.equal(info.stdout.lastIndexOf(usagePhrase, 0), 0,
            'stdout from mchoose');

        t.end();
    });
});
