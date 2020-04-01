#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

#
# Tools
#
NPM_EXEC	:= $(shell which npm)
TAP_EXEC	:= ./node_modules/.bin/tap

#
# Configuration used by Makefile.defs and Makefile.targ to generate
# "check" and "docs" targets.
#
JS_FILES	:= $(shell find lib test -name '*.js')
ESLINT		:= ./node_modules/.bin/eslint
ESLINT_FILES	:= $(JS_FILES)

CLEAN_FILES += ./node_modules npm-debug.log storinfo-*.tgz test.unit.tap


.PHONY: all
all $(TAP_EXEC) $(ESLINT):
	$(NPM_EXEC) install

clean:
	rm -rf $(CLEAN_FILES)

.PHONY: test
test: | $(TAP_EXEC)
	TAP=1 $(TAP_EXEC) --output-file=./test.unit.tap test/*.test.js

check:: check-version check-eslint

# Ensure CHANGES.md and package.json have the same version.
.PHONY: check-version
check-version:
	@echo version is: $(shell cat package.json | json version)
	[[ `cat package.json | json version` == `grep '^## ' CHANGES.md | head -2 | tail -1 | awk '{print $$2}'` ]]

.PHONY: check-eslint
check-eslint:: | $(ESLINT)
	$(ESLINT) $(ESLINT_FILES)

.PHONY: fmt
fmt:: | $(ESLINT)
	$(ESLINT) --fix $(ESLINT_FILES)

.PHONY: cutarelease
cutarelease: check
	[[ -z `git status --short` ]]  # If this fails, the working dir is dirty.
	@which json 2>/dev/null 1>/dev/null && \
	    ver=$(shell json -f package.json version) && \
	    name=$(shell json -f package.json name) && \
	    publishedVer=$(shell npm view -j $(shell json -f package.json name)@$(shell json -f package.json version) 2>/dev/null | json version) && \
	    if [[ -n "$$publishedVer" ]]; then \
		echo "error: $$name@$$ver is already published to npm"; \
		exit 1; \
	    fi && \
	    echo "** Are you sure you want to tag and publish $$name@$$ver to npm?" && \
	    echo "** Enter to continue, Ctrl+C to abort." && \
	    read
	ver=$(shell cat package.json | json version) && \
	    date=$(shell date -u "+%Y-%m-%d") && \
	    git tag -a "v$$ver" -m "version $$ver ($$date)" && \
	    git push --tags origin && \
	    npm publish
