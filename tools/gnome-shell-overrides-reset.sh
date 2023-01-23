#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright 2023 Endless OS Foundation LLC

# Essentially, this script partially undoes what the old
# `gnome-shell-overrides-migration.sh` script[1] did, but only on EOS. This is
# needed because on EOS versions <5, the schema for
# `org.gnome.shell.overrides.dynamic-workspaces` was overridden[2]. That meant
# the migration script copied the overridden value into the user’s dconf data
# as `org.gnome.mutter.dynamic-workspaces`. This persists in the user’s dconf
# data across an upgrade from EOS 4 → 5. In EOS 5, the schema override was
# dropped to enable dynamic workspaces by default. For users who’ve upgraded,
# though, the old migrated value in their dconf database takes precedence,
# meaning that dynamic workspaces are disabled for them.
# This script resets the `dynamic-workspaces` key to its default value, and is
# intended to be used on EOS 5. It won’t delete user-modified configuration
# values, as the `dynamic-workspaces` key was not configurable via the UI in
# EOS <5. It runs once.
#
# See https://phabricator.endlessm.com/T34300
#
# This script can be deleted any time after the first OSTree checkpoint after
# the release of EOS 5.
#
# [1]: https://github.com/endlessm/gnome-shell/blob/master/tools/gnome-shell-overrides-migration.sh
# [2]: https://github.com/endlessm/eos-theme/pull/369

PKG_DATA_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell

# This reuses the migration stamp file from the old
# `gnome-shell-overrides-migration.sh` script[1], so that it’s cleaned up at the
# same time.
OLD_MIGRATION_GUARD=$PKG_DATA_DIR/gnome-overrides-migrated

if [ ! -f "${OLD_MIGRATION_GUARD}" ]; then
  exit # already reset
fi

# Find the right session
if echo "${XDG_CURRENT_DESKTOP}" | grep -q -v GNOME; then
  exit # not a GNOME session
fi

# https://github.com/endlessm/eos-theme/pull/369
gsettings reset org.gnome.mutter dynamic-workspaces && \
rm -f "${OLD_MIGRATION_GUARD}"