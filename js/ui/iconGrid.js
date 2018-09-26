// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Pango = imports.gi.Pango;
const Signals = imports.signals;
const St = imports.gi.St;

const Lang = imports.lang;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;
const Main = imports.ui.main;

const EditableLabel = imports.ui.editableLabel;

var ICON_SIZE = 64;
var MIN_ICON_SIZE = 16;

var EXTRA_SPACE_ANIMATION_TIME = 0.25;

var ANIMATION_TIME_IN = 0.350;
var ANIMATION_TIME_OUT = 1/2 * ANIMATION_TIME_IN;
var ANIMATION_MAX_DELAY_FOR_ITEM = 2/3 * ANIMATION_TIME_IN;
var ANIMATION_BASE_DELAY_FOR_ITEM = 1/4 * ANIMATION_MAX_DELAY_FOR_ITEM;
var ANIMATION_MAX_DELAY_OUT_FOR_ITEM = 2/3 * ANIMATION_TIME_OUT;
var ANIMATION_FADE_IN_TIME_FOR_ITEM = 1/4 * ANIMATION_TIME_IN;

var ANIMATION_BOUNCE_ICON_SCALE = 1.1;

var AnimationDirection = {
    IN: 0,
    OUT: 1
};

var APPICON_ANIMATION_OUT_SCALE = 3;
var APPICON_ANIMATION_OUT_TIME = 0.25;

// Endless-specific definitions below this point

const LEFT_DIVIDER_LEEWAY = 30;
const RIGHT_DIVIDER_LEEWAY = 30;

const NUDGE_ANIMATION_TYPE = 'easeOutElastic';
const NUDGE_DURATION = 0.8;
const NUDGE_PERIOD = 0.7;

const NUDGE_RETURN_ANIMATION_TYPE = 'easeOutQuint';
const NUDGE_RETURN_DURATION = 0.3;

const NUDGE_FACTOR = 0.2;

var CursorLocation = {
    DEFAULT: 0,
    ON_ICON: 1,
    START_EDGE: 2,
    END_EDGE: 3,
    EMPTY_AREA: 4
}

var BaseIcon = new Lang.Class({
    Name: 'BaseIcon',
    Extends: St.Bin,

    _init : function(label, params) {
        params = Params.parse(params, { createIcon: null,
                                        createExtraIcons: null,
                                        setSizeManually: false,
                                        editable: false,
                                        showLabel: true });

        let styleClass = 'overview-icon';
        if (params.showLabel)
            styleClass += ' overview-icon-with-label';

        this.parent({ style_class: styleClass,
                      x_fill: true,
                      x_align: Clutter.ActorAlign.CENTER,
                      y_fill: true,
                      y_align: Clutter.ActorAlign.CENTER });

        this.actor = this;

        this.connect('destroy', this._onDestroy.bind(this));

        this._box = new St.BoxLayout({ vertical: true });
        this.set_child(this._box);

        this.iconSize = ICON_SIZE;
        this._iconBin = new St.Bin({ x_align: St.Align.MIDDLE,
                                     y_align: St.Align.MIDDLE });
        this._iconBin.add_style_class_name('icon-button');

        this._box.add_actor(this._iconBin);

        this._layeredIcon = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                            visible: true,
                                            x_expand: true,
                                            y_expand: true,
                                            width: this.iconSize,
                                            height: this.iconSize });
        this._iconBin.add_actor(this._layeredIcon);

        let shadow = new St.Widget({ style_class: 'shadow-icon',
                                     visible: true,
                                     x_expand: true,
                                     y_expand: true });
        this._layeredIcon.add_actor(shadow);

        this._editable = params.editable;
        if (params.showLabel) {
            if (this._editable) {
                this.label = new EditableLabel.EditableLabel({ text: label,
                                                               style_class: 'overview-icon-label' });
            } else {
                this.label = new St.Label({ text: label,
                                            style_class: 'overview-icon-label' });

                this.label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
                this.label.clutter_text.y_align = Clutter.ActorAlign.CENTER;
                this.label.clutter_text.line_wrap = true;
                this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            }
            this._box.add_actor(this.label);
        } else {
            this.label = null;
        }

        if (params.createIcon)
            this.createIcon = params.createIcon;
        if (params.createExtraIcons)
            this.createExtraIcons = params.createExtraIcons;
        this._setSizeManually = params.setSizeManually;

        this.icon = null;
        this.extraIcons = [];

        let cache = St.TextureCache.get_default();
        this._iconThemeChangedId = cache.connect('icon-theme-changed', Lang.bind(this, this._onIconThemeChanged));
    },

    vfunc_get_preferred_width(forHeight) {
        // Return the actual height to keep the squared aspect
        return this.get_preferred_height(-1);
    },

    // This can be overridden by a subclass, or by the createIcon
    // parameter to _init()
    createIcon: function(size) {
        throw new Error('no implementation of createIcon in ' + this);
    },

    // This can be overridden by a subclass, or by the createExtraIcons
    // parameter to _init()
    createExtraIcons: function(size) {
        return [];
    },

    setIconSize: function(size) {
        if (!this._setSizeManually)
            throw new Error('setSizeManually has to be set to use setIconsize');

        if (size == this.iconSize)
            return;

        this._createIconTexture(size);
    },

    _createIconTexture: function(size) {
        if (this.icon)
            this.icon.destroy();
        this.extraIcons.forEach(function (i) {
            i.destroy();
        });
        this.iconSize = size;
        this.icon = this.createIcon(this.iconSize);
        this.extraIcons = this.createExtraIcons(this.iconSize);

        this._layeredIcon.add_actor(this.icon);
        this._layeredIcon.set_child_below_sibling(this.icon, null);

        this.extraIcons.forEach(Lang.bind(this, function (i) {
            this._layeredIcon.add_actor(i);
        }));

        // The icon returned by createIcon() might actually be smaller than
        // the requested icon size (for instance StTextureCache does this
        // for fallback icons), so set the size explicitly.
        this._layeredIcon.set_size(this.iconSize, this.iconSize);
    },

    vfunc_style_changed() {
        let node = this.get_theme_node();

        let size;
        if (this._setSizeManually) {
            size = this.iconSize;
        } else {
            let [found, len] = node.lookup_length('icon-size', false);
            size = found ? len : ICON_SIZE;
        }

        if (this.iconSize == size && this.icon !== null)
            return;

        this._createIconTexture(size);
    },

    _onDestroy: function() {
        if (this._iconThemeChangedId > 0) {
            let cache = St.TextureCache.get_default();
            cache.disconnect(this._iconThemeChangedId);
            this._iconThemeChangedId = 0;
        }
    },

    _onIconThemeChanged: function() {
        this._createIconTexture(this.iconSize);
    },

    animateZoomOut: function() {
        // Animate only the child instead of the entire actor, so the
        // styles like hover and running are not applied while
        // animating.
        zoomOutActor(this.child);
    },

    reloadIcon: function() {
        this._createIconTexture(this.iconSize);
    },

    setLabelMode: function(mode) {
        if (!this._editable)
            return;
        this.label.setMode(mode);
    }
});

function clamp(value, min, max) {
    return Math.max(Math.min(value, max), min);
};

function zoomOutActor(actor) {
    let actorClone = new Clutter.Clone({ source: actor,
                                         reactive: false });
    let [width, height] = actor.get_transformed_size();
    let [x, y] = actor.get_transformed_position();
    actorClone.set_size(width, height);
    actorClone.set_position(x, y);
    actorClone.opacity = 255;
    actorClone.set_pivot_point(0.5, 0.5);

    Main.uiGroup.add_actor(actorClone);

    // Avoid monitor edges to not zoom outside the current monitor
    let monitor = Main.layoutManager.findMonitorForActor(actor);
    let scaledWidth = width * APPICON_ANIMATION_OUT_SCALE;
    let scaledHeight = height * APPICON_ANIMATION_OUT_SCALE;
    let scaledX = x - (scaledWidth - width) / 2;
    let scaledY = y - (scaledHeight - height) / 2;
    let containedX = clamp(scaledX, monitor.x, monitor.x + monitor.width - scaledWidth);
    let containedY = clamp(scaledY, monitor.y, monitor.y + monitor.height - scaledHeight);

    Tweener.addTween(actorClone,
                     { time: APPICON_ANIMATION_OUT_TIME,
                       scale_x: APPICON_ANIMATION_OUT_SCALE,
                       scale_y: APPICON_ANIMATION_OUT_SCALE,
                       translation_x: containedX - scaledX,
                       translation_y: containedY - scaledY,
                       opacity: 0,
                       transition: 'easeOutQuad',
                       onComplete: function() {
                           actorClone.destroy();
                       }
                    });
}

var IconGrid = new Lang.Class({
    Name: 'IconGrid',
    Extends: St.Widget,
    Signals: {'animation-done': {},
              'child-focused': { param_types: [Clutter.Actor.$gtype]} },

    _init(params) {
        this.parent({ style_class: 'icon-grid',
                      y_align: Clutter.ActorAlign.START });

        this.actor = this;

        params = Params.parse(params, { rowLimit: null,
                                        columnLimit: null,
                                        minRows: 1,
                                        minColumns: 1,
                                        fillParent: false,
                                        xAlign: St.Align.MIDDLE,
                                        padWithSpacing: false });
        this._rowLimit = params.rowLimit;
        this._colLimit = params.columnLimit;
        this._minRows = params.minRows;
        this._minColumns = params.minColumns;
        this._xAlign = params.xAlign;
        this._fillParent = params.fillParent;
        this._padWithSpacing = params.padWithSpacing;

        this._leftPadding = 0;
        this._allocatedColumns = 0;

        this.topPadding = 0;
        this.bottomPadding = 0;
        this.rightPadding = 0;
        this.leftPadding = 0;

        this._items = [];
        this._clonesAnimating = [];
        // Pulled from CSS, but hardcode some defaults here
        this._spacing = 0;
        this._hItemSize = this._vItemSize = ICON_SIZE;
        this._fixedHItemSize = this._fixedVItemSize = undefined;
        this.connect('style-changed', this._onStyleChanged.bind(this));

        // Cancel animations when hiding the overview, to avoid icons
        // swarming into the void ...
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                this._cancelAnimation();
        });

        this.connect('actor-added', this._childAdded.bind(this));
        this.connect('actor-removed', this._childRemoved.bind(this));
    },

    _keyFocusIn(actor) {
        this.emit('child-focused', actor);
    },

    _childAdded: function(grid, child) {
        child._iconGridKeyFocusInId = child.connect('key-focus-in', Lang.bind(this, this._keyFocusIn));
    },

    _childRemoved: function(grid, child) {
        child.disconnect(child._iconGridKeyFocusInId);
    },

    vfunc_get_preferred_width(forHeight) {
        if (this._fillParent)
            // Ignore all size requests of children and request a size of 0;
            // later we'll allocate as many children as fit the parent
            return [0, 0];

        let nChildren = this.get_n_children();
        let nColumns = this._colLimit ? Math.min(this._colLimit,
                                                 nChildren)
                                      : nChildren;
        let totalSpacing = Math.max(0, nColumns - 1) * this._getSpacing();
        // Kind of a lie, but not really an issue right now.  If
        // we wanted to support some sort of hidden/overflow that would
        // need higher level design
        let minSize = this._getHItemSize() + this.leftPadding + this.rightPadding;
        let natSize = nColumns * this._getHItemSize() + totalSpacing + this.leftPadding + this.rightPadding;

        return this.get_theme_node().adjust_preferred_width(minSize, natSize);
    },

    _getVisibleChildren() {
        return this.get_children().filter(actor => actor.visible);
    },

    vfunc_get_preferred_height(forWidth) {
        if (this._fillParent)
            // Ignore all size requests of children and request a size of 0;
            // later we'll allocate as many children as fit the parent
            return [0, 0];

        let themeNode = this.get_theme_node();
        let children = this._getVisibleChildren();
        let nColumns;

        forWidth = themeNode.adjust_for_width(forWidth);

        if (forWidth < 0)
            nColumns = children.length;
        else
            [nColumns, ] = this._computeLayout(forWidth);

        let nRows;
        if (nColumns > 0)
            nRows = Math.ceil(children.length / nColumns);
        else
            nRows = 0;
        if (this._rowLimit)
            nRows = Math.min(nRows, this._rowLimit);
        let totalSpacing = Math.max(0, nRows - 1) * this._getSpacing();
        let height = nRows * this._getVItemSize() + totalSpacing + this.topPadding + this.bottomPadding;

        return themeNode.adjust_preferred_height(height, height);
    },

    vfunc_allocate(box, flags) {
        this.set_allocation(box, flags);

        let themeNode = this.get_theme_node();
        box = themeNode.get_content_box(box);

        if (this._fillParent) {
            // Reset the passed in box to fill the parent
            let parentBox = this.get_parent().allocation;
            let gridBox = themeNode.get_content_box(parentBox);
            box = themeNode.get_content_box(gridBox);
        }

        let children = this._getVisibleChildren();
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let spacing = this._getSpacing();
        let [nColumns, usedWidth] = this._computeLayout(availWidth);

        let leftEmptySpace;
        switch(this._xAlign) {
            case St.Align.START:
                leftEmptySpace = 0;
                break;
            case St.Align.MIDDLE:
                leftEmptySpace = Math.floor((availWidth - usedWidth) / 2);
                break;
            case St.Align.END:
                leftEmptySpace = availWidth - usedWidth;
        }

        // Store some information about the allocated layout
        this._leftPadding = leftEmptySpace;
        this._allocatedColumns = nColumns;

        let x = box.x1 + leftEmptySpace + this.leftPadding;
        let y = box.y1 + this.topPadding;
        let columnIndex = 0;
        let rowIndex = 0;
        for (let i = 0; i < children.length; i++) {
            let childBox = this._calculateChildBox(children[i], x, y, box);

            if (this._rowLimit && rowIndex >= this._rowLimit ||
                this._fillParent && childBox.y2 > availHeight - this.bottomPadding) {
                children[i]._skipPaint = true;
            } else {
                children[i].allocate(childBox, flags);
                children[i]._skipPaint = false;
            }

            columnIndex++;
            if (columnIndex == nColumns) {
                columnIndex = 0;
                rowIndex++;
            }

            if (columnIndex == 0) {
                y += this._getVItemSize() + spacing;
                x = box.x1 + leftEmptySpace + this.leftPadding;
            } else {
                x += this._getHItemSize() + spacing;
            }
        }
    },

    vfunc_paint() {
        this.paint_background();

        this.get_children().forEach(c => {
            if (!c._skipPaint)
                c.paint();
        });
    },

    vfunc_pick(color) {
        this.parent(color);

        this.get_children().forEach(c => {
            if (!c._skipPaint)
                c.paint();
        });
    },

    vfunc_get_paint_volume(paintVolume) {
        // Setting the paint volume does not make sense when we don't have
        // any allocation
        if (!this.has_allocation())
            return false;

        let themeNode = this.get_theme_node();
        let allocationBox = this.get_allocation_box();
        let paintBox = themeNode.get_paint_box(allocationBox);

        let origin = new Clutter.Vertex();
        origin.x = paintBox.x1 - allocationBox.x1;
        origin.y = paintBox.y1 - allocationBox.y1;
        origin.z = 0.0;

        paintVolume.set_origin(origin);
        paintVolume.set_width(paintBox.x2 - paintBox.x1);
        paintVolume.set_height(paintBox.y2 - paintBox.y1);

        if (this.get_clip_to_allocation())
            return true;

        for (let child = this.get_first_child();
             child != null;
             child = child.get_next_sibling()) {

            if (!child.visible)
                continue;

            if (child._skipPaint)
                continue;

            let childVolume = child.get_transformed_paint_volume(this);
            if (!childVolume)
                return false

            paintVolume.union(childVolume);
        }

        return true;
    },

    /**
     * Intended to be override by subclasses if they need a different
     * set of items to be animated.
     */
    _getChildrenToAnimate: function() {
        return this._getVisibleChildren();
    },

    _cancelAnimation: function() {
        this._clonesAnimating.forEach(clone => { clone.destroy(); });
        this._clonesAnimating = [];
    },

    _animationDone: function() {
        this._clonesAnimating = [];
        this.emit('animation-done');
    },

    animatePulse: function(animationDirection) {
        if (animationDirection != AnimationDirection.IN)
            throw new Error("Pulse animation only implements 'in' animation direction");

        this._cancelAnimation();

        let actors = this._getChildrenToAnimate();
        if (actors.length == 0) {
            this._animationDone();
            return;
        }

        // For few items the animation can be slow, so use a smaller
        // delay when there are less than 4 items
        // (ANIMATION_BASE_DELAY_FOR_ITEM = 1/4 *
        // ANIMATION_MAX_DELAY_FOR_ITEM)
        let maxDelay = Math.min(ANIMATION_BASE_DELAY_FOR_ITEM * actors.length,
                                ANIMATION_MAX_DELAY_FOR_ITEM);

        for (let index = 0; index < actors.length; index++) {
            let actor = actors[index];
            actor.reactive = false;
            actor.set_scale(0, 0);
            actor.set_pivot_point(0.5, 0.5);

            let delay = index / actors.length * maxDelay;
            let bounceUpTime = ANIMATION_TIME_IN / 4;
            let isLastItem = index == actors.length - 1;
            Tweener.addTween(actor,
                            { time: bounceUpTime,
                              transition: 'easeInOutQuad',
                              delay: delay,
                              scale_x: ANIMATION_BOUNCE_ICON_SCALE,
                              scale_y: ANIMATION_BOUNCE_ICON_SCALE,
                              onComplete: Lang.bind(this, function() {
                                  Tweener.addTween(actor,
                                                   { time: ANIMATION_TIME_IN - bounceUpTime,
                                                     transition: 'easeInOutQuad',
                                                     scale_x: 1,
                                                     scale_y: 1,
                                                     onComplete: Lang.bind(this, function() {
                                                        if (isLastItem)
                                                            this._animationDone();
                                                        actor.reactive = true;
                                                    })
                                                   });
                              })
                            });
        }
    },

    animateSpring: function(animationDirection, sourceActor) {
        // We don't do the icon grid animations on Endless
        this._animationDone();
    },

    _restoreItemsOpacity: function() {
        for (let index = 0; index < this._items.length; index++) {
            this._items[index].actor.opacity = 255;
        }
    },

    _getAllocatedChildSizeAndSpacing: function(child) {
        let [,, natWidth, natHeight] = child.get_preferred_size();
        let width = Math.min(this._getHItemSize(), natWidth);
        let xSpacing = Math.max(0, width - natWidth) / 2;
        let height = Math.min(this._getVItemSize(), natHeight);
        let ySpacing = Math.max(0, height - natHeight) / 2;
        return [width, height, xSpacing, ySpacing];
    },

    _calculateChildBox: function(child, x, y, box) {
        /* Center the item in its allocation horizontally */
        let [width, height, childXSpacing, childYSpacing] =
            this._getAllocatedChildSizeAndSpacing(child);

        let childBox = new Clutter.ActorBox();
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL) {
            let _x = box.x2 - (x + width);
            childBox.x1 = Math.floor(_x - childXSpacing);
        } else {
            childBox.x1 = Math.floor(x + childXSpacing);
        }
        childBox.y1 = Math.floor(y + childYSpacing);
        childBox.x2 = childBox.x1 + width;
        childBox.y2 = childBox.y1 + height;
        return childBox;
    },

    columnsForWidth: function(rowWidth) {
        return this._computeLayout(rowWidth)[0];
    },

    getRowLimit: function() {
        return this._rowLimit;
    },

    _computeLayout: function (forWidth) {
        let nColumns = 0;
        let usedWidth = this.leftPadding + this.rightPadding;
        let spacing = this._getSpacing();

        while ((this._colLimit == null || nColumns < this._colLimit) &&
               (usedWidth + this._getHItemSize() <= forWidth)) {
            usedWidth += this._getHItemSize() + spacing;
            nColumns += 1;
        }

        if (nColumns > 0)
            usedWidth -= spacing;

        return [nColumns, usedWidth];
    },

    _onStyleChanged() {
        let themeNode = this.get_theme_node();
        this._spacing = themeNode.get_length('spacing');
        this._hItemSize = themeNode.get_length('-shell-grid-horizontal-item-size') || ICON_SIZE;
        this._vItemSize = themeNode.get_length('-shell-grid-vertical-item-size') || ICON_SIZE;
        this.queue_relayout();
    },

    nRows: function(forWidth) {
        let children = this._getVisibleChildren();
        let nColumns = (forWidth < 0) ? children.length : this._computeLayout(forWidth)[0];
        let nRows = (nColumns > 0) ? Math.ceil(children.length / nColumns) : 0;
        if (this._rowLimit)
            nRows = Math.min(nRows, this._rowLimit);
        return nRows;
    },

    rowsForHeight: function(forHeight) {
        return Math.floor((forHeight - (this.topPadding + this.bottomPadding) + this._getSpacing()) / (this._getVItemSize() + this._getSpacing()));
    },

    usedHeightForNRows: function(nRows) {
        return (this._getVItemSize() + this._getSpacing()) * nRows - this._getSpacing() + this.topPadding + this.bottomPadding;
    },

    usedWidth: function(forWidth) {
        return this.usedWidthForNColumns(this.columnsForWidth(forWidth));
    },

    usedWidthForNColumns: function(columns) {
        let usedWidth = columns  * (this._getHItemSize() + this._getSpacing());
        usedWidth -= this._getSpacing();
        return usedWidth + this.leftPadding + this.rightPadding;
    },

    removeAll: function() {
        this._items = [];
        this.remove_all_children();
    },

    destroyAll: function() {
        this._items = [];
        this.destroy_all_children();
    },

    addItem: function(item, index) {
        if (!item.icon instanceof BaseIcon)
            throw new Error('Only items with a BaseIcon icon property can be added to IconGrid');

        this._items.push(item);
        if (index !== undefined)
            this.insert_child_at_index(item.actor, index);
        else
            this.add_actor(item.actor);
    },

    removeItem(item) {
        this.remove_child(item.actor);
    },

    getItemAtIndex(index) {
        return this.get_child_at_index(index);
    },

    visibleItemsCount() {
        return this.get_children().filter(c => !c._skipPaint).length;
    },

    setSpacing: function(spacing) {
        this._fixedSpacing = spacing;
    },

    _getSpacing: function() {
        return this._fixedSpacing ? this._fixedSpacing : this._spacing;
    },

    _getHItemSize: function() {
        return this._fixedHItemSize ? this._fixedHItemSize : this._hItemSize;
    },

    _getVItemSize: function() {
        return this._fixedVItemSize ? this._fixedVItemSize : this._vItemSize;
    },

    /**
     * This function must to be called before iconGrid allocation,
     * to know how much spacing can the grid has
     */
    adaptToSize: function(availWidth, availHeight) {
        this._fixedHItemSize = this._hItemSize;
        this._fixedVItemSize = this._vItemSize;
    },

    // DnD support

    nudgeItemsAtIndex: function(index, cursorLocation) {
        // No nudging when the cursor is in an empty area
        if (cursorLocation == CursorLocation.EMPTY_AREA)
            return;

        let nudgeIdx = index;
        let rtl = (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL);

        if (cursorLocation != CursorLocation.START_EDGE) {
            let leftItem = this.getItemAtIndex(nudgeIdx - 1);
            this._animateNudge(leftItem, NUDGE_ANIMATION_TYPE, NUDGE_DURATION,
                               rtl ? Math.floor(this._hItemSize * NUDGE_FACTOR) : Math.floor(-this._hItemSize * NUDGE_FACTOR));
        }

        // Nudge the icon to the right if we are the first item or not at the
        // end of row
        if (cursorLocation != CursorLocation.END_EDGE) {
            let rightItem = this.getItemAtIndex(nudgeIdx);
            this._animateNudge(rightItem, NUDGE_ANIMATION_TYPE, NUDGE_DURATION,
                               rtl ? Math.floor(-this._hItemSize * NUDGE_FACTOR) : Math.floor(this._hItemSize * NUDGE_FACTOR));
        }
    },

    removeNudgeTransforms: function() {
        let children = this.get_children();
        for (let index = 0; index < children.length; index++) {
            this._animateNudge(children[index], NUDGE_RETURN_ANIMATION_TYPE,
                               NUDGE_RETURN_DURATION,
                               0);
        }
    },

    _animateNudge: function(item, animationType, duration, offset) {
        if (!item)
            return;

        Tweener.addTween(item, { translation_x: offset,
                                 time: duration,
                                 transition: animationType,
                                 transitionParams: { period: duration * 1000 * NUDGE_PERIOD }
                               });
    },

    indexOf: function(item) {
        let children = this.get_children();
        for (let i = 0; i < children.length; i++) {
            if (item == children[i])
                return i;
        }

        return -1;
    },

    // This function is overriden by the PaginatedIconGrid subclass so we can
    // take into account the extra space when dragging from a folder
    _calculateDndRow: function(y) {
        let rowHeight = this._getVItemSize() + this._getSpacing();
        return Math.floor(y / rowHeight);
    },

    // Returns the drop point index or -1 if we can't drop there
    canDropAt: function(x, y, canDropPastEnd) {
        let [ok, sx, sy] = this.actor.transform_stage_point(x, y);
        if (!ok)
            return [-1, CursorLocation.DEFAULT];

        let [sw, sh] = this.actor.get_transformed_size();
        let usedWidth = sw;

        // Undo the align translation from _allocate()
        if (this._xAlign == St.Align.MIDDLE)
            usedWidth -= 2 * this._leftPadding;
        else if (this._xAlign == St.Align.END)
            usedWidth -= this._leftPadding;

        let row = this._calculateDndRow(sy);

        // Correct sx to handle the left padding
        // to correctly calculate the column
        let rtl = (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL);
        let gridX = sx - this._leftPadding;
        if (rtl)
            gridX = usedWidth - gridX;

        let columnWidth = this._getHItemSize() + this._getSpacing();
        let column = Math.floor(gridX / columnWidth);

        // If we're outside of the grid, we are in an invalid drop location
        if (gridX < 0 || gridX > usedWidth)
            return [-1, CursorLocation.DEFAULT];

        let children = this.get_children();
        let childIdx = Math.min((row * this._allocatedColumns) + column, children.length);

        // If we're above the grid vertically,
        // we are in an invalid drop location
        if (childIdx < 0)
            return [-1, CursorLocation.DEFAULT];

        // If we're past the last visible element in the grid,
        // we might be allowed to drop there.
        if (childIdx >= children.length) {
            if (canDropPastEnd)
                return [children.length, CursorLocation.EMPTY_AREA];

            return [-1, CursorLocation.DEFAULT];
        }

        let child = children[childIdx];
        let [childMinWidth, childMinHeight, childNaturalWidth, childNaturalHeight] = child.get_preferred_size();

        // This is the width of the cell that contains the icon
        // (excluding spacing between cells)
        let childIconWidth = Math.max(this._getHItemSize(), childNaturalWidth);

        // Calculate the original position of the child icon (prior to nudging)
        let cx;
        if (rtl)
            cx = this._leftPadding + usedWidth - (column * columnWidth) - childIconWidth;
        else
            cx = this._leftPadding + (column * columnWidth);

        // childIconWidth is used to determine whether or not a drag point
        // is inside the icon or the divider.

        // Reduce the size of the icon area further by only having it start
        // further in.  If the drop point is in those initial pixels
        // then the drop point is the current icon
        //
        // Increasing cx and decreasing childIconWidth gives a greater priority
        // to rearranging icons on the desktop vs putting them into folders
        // Decreasing cx and increasing childIconWidth gives a greater priority
        // to putting icons in folders vs rearranging them on the desktop
        let iconLeftX = cx + LEFT_DIVIDER_LEEWAY;
        let iconRightX = cx + childIconWidth - RIGHT_DIVIDER_LEEWAY;
        let leftEdge = this._leftPadding + LEFT_DIVIDER_LEEWAY;
        let rightEdge = this._leftPadding + usedWidth - RIGHT_DIVIDER_LEEWAY;

        let dropIdx;
        let cursorLocation;

        if (sx < iconLeftX) {
            // We are to the left of the icon target
            if (sx < leftEdge) {
                // We are before the leftmost icon on the grid
                if (rtl) {
                    dropIdx = childIdx + 1;
                    cursorLocation = CursorLocation.END_EDGE;
                } else {
                    dropIdx = childIdx;
                    cursorLocation = CursorLocation.START_EDGE;
                }
            } else {
                // We are between the previous icon (next in RTL) and this one
                if (rtl)
                    dropIdx = childIdx + 1;
                else
                    dropIdx = childIdx;

                cursorLocation = CursorLocation.DEFAULT;
            }
        } else if (sx >= iconRightX) {
            // We are to the right of the icon target
            if (childIdx >= children.length - (canDropPastEnd ? 0 : 1)) {
                // We are beyond the last valid icon
                // (to the right of the app store / trash can, if present)
                dropIdx = -1;
                cursorLocation = CursorLocation.DEFAULT;
            } else if (sx >= rightEdge) {
                // We are beyond the rightmost icon on the grid
                if (rtl) {
                    dropIdx = childIdx;
                    cursorLocation = CursorLocation.START_EDGE;
                } else {
                    dropIdx = childIdx + 1;
                    cursorLocation = CursorLocation.END_EDGE;
                }
            } else {
                // We are between this icon and the next one (previous in RTL)
                if (rtl)
                    dropIdx = childIdx;
                else
                    dropIdx = childIdx + 1;

                cursorLocation = CursorLocation.DEFAULT;
            }
        } else {
            // We are over the icon target area
            dropIdx = childIdx;
            cursorLocation = CursorLocation.ON_ICON;
        }

        return [dropIdx, cursorLocation];
    }
});

var PaginatedIconGrid = new Lang.Class({
    Name: 'PaginatedIconGrid',
    Extends: IconGrid,
    Signals: {'space-opened': {},
              'space-closed': {} },

    _init: function(params) {
        this.parent(params);
        this._nPages = 0;
        this.currentPage = 0;
        this._rowsPerPage = 0;
        this._spaceBetweenPages = 0;
        this._childrenPerPage = 0;
        this._maxRowsPerPage = 0;
        this._extraSpaceData = null;
    },

    vfunc_get_preferred_height(forWidth) {
        let height = (this._availableHeightPerPageForItems() + this.bottomPadding + this.topPadding) * this._nPages + this._spaceBetweenPages * this._nPages;
        return [height, height];
    },

    vfunc_allocate(box, flags) {
         if (this._childrenPerPage == 0)
            log('computePages() must be called before allocate(); pagination will not work.');

        this.set_allocation(box, flags);

        if (this._fillParent) {
            // Reset the passed in box to fill the parent
            let parentBox = this.get_parent().allocation;
            let gridBox = this.get_theme_node().get_content_box(parentBox);
            box = this.get_theme_node().get_content_box(gridBox);
        }
        let children = this._getVisibleChildren();
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let spacing = this._getSpacing();
        let [nColumns, usedWidth] = this._computeLayout(availWidth);

        let leftEmptySpace;
        switch(this._xAlign) {
            case St.Align.START:
                leftEmptySpace = 0;
                break;
            case St.Align.MIDDLE:
                leftEmptySpace = Math.floor((availWidth - usedWidth) / 2);
                break;
            case St.Align.END:
                leftEmptySpace = availWidth - usedWidth;
        }

        // Store some information about the allocated layout
        this._leftPadding = leftEmptySpace;
        this._allocatedColumns = nColumns;

        let x = box.x1 + leftEmptySpace + this.leftPadding;
        let y = box.y1 + this.topPadding;
        let columnIndex = 0;
        let rowIndex = 0;

        for (let i = 0; i < children.length; i++) {
            let childBox = this._calculateChildBox(children[i], x, y, box);
            children[i].allocate(childBox, flags);
            children[i]._skipPaint = false;

            columnIndex++;
            if (columnIndex == nColumns) {
                columnIndex = 0;
                rowIndex++;
            }
            if (columnIndex == 0) {
                y += this._getVItemSize() + spacing;
                if ((i + 1) % this._childrenPerPage == 0)
                    y +=  this._spaceBetweenPages - spacing + this.bottomPadding + this.topPadding;
                x = box.x1 + leftEmptySpace + this.leftPadding;
            } else
                x += this._getHItemSize() + spacing;
        }
    },

    // Overriden from IconGrid
    _getChildrenToAnimate: function() {
        let children = this._getVisibleChildren();
        let firstIndex = this._childrenPerPage * this.currentPage;
        let lastIndex = firstIndex + this._childrenPerPage;

        return children.slice(firstIndex, lastIndex);
    },

    _computePages: function (availWidthPerPage, availHeightPerPage) {
        let [nColumns, usedWidth] = this._computeLayout(availWidthPerPage);
        let nRows;
        let children = this._getVisibleChildren();
        if (nColumns > 0)
            nRows = Math.ceil(children.length / nColumns);
        else
            nRows = 0;
        if (this._rowLimit)
            nRows = Math.min(nRows, this._rowLimit);

        let spacing = this._getSpacing();
        // We want to contain the grid inside the parent box with padding
        this._rowsPerPage = Math.min(Math.max (this._minRows, nRows), this.rowsForHeight(availHeightPerPage));
        this._nPages = Math.ceil(nRows / this._rowsPerPage);

        if (this._nPages > 1)
            this._spaceBetweenPages = availHeightPerPage - (this.topPadding + this.bottomPadding) - this._availableHeightPerPageForItems();
        else
            this._spaceBetweenPages = this._getSpacing();

        this._childrenPerPage = nColumns * this._rowsPerPage;
        this._maxRowsPerPage = this.rowsForHeight(availHeightPerPage);
    },

    _calculateDndRow: function(y) {
        let row = this.parent(y);

        // If there's no extra space, just return the current value and maintain
        // the same behavior when without a folder opened.
        if (!this._extraSpaceData)
            return row;

        let [ baseRow, nRowsUp, nRowsDown ] = this._extraSpaceData;
        let newRow = row + nRowsUp;

        if (row > baseRow)
            newRow -= nRowsDown;

        return newRow;
    },

    adaptToSize: function(availWidth, availHeight) {
        this.parent(availWidth, availHeight);
        this._computePages(availWidth, availHeight);
    },

    _availableHeightPerPageForItems: function() {
        return this.usedHeightForNRows(this._rowsPerPage) - (this.topPadding + this.bottomPadding);
    },

    nPages: function() {
        return this._nPages;
    },

    getPageHeight: function() {
        return this._availableHeightPerPageForItems();
    },

    getPageY: function(pageNumber) {
        if (!this._nPages)
            return 0;

        let firstPageItem = pageNumber * this._childrenPerPage
        let childBox = this._getVisibleChildren()[firstPageItem].get_allocation_box();
        return childBox.y1 - this.topPadding;
    },

    getItemPage: function(item) {
        let children = this._getVisibleChildren();
        let index = children.indexOf(item);
        if (index == -1) {
            throw new Error('Item not found.');
            return 0;
        }
        return Math.floor(index / this._childrenPerPage);
    },

    /**
    * openExtraSpace:
    * @sourceItem: the item for which to create extra space
    * @side: where @sourceItem should be located relative to the created space
    * @nRows: the amount of space to create
    *
    * Pan view to create extra space for @nRows above or below @sourceItem.
    */
    openExtraSpace: function(sourceItem, side, nRows) {
        let children = this._getVisibleChildren();
        let index = children.indexOf(sourceItem.actor);
        if (index == -1) {
            throw new Error('Item not found.');
            return;
        }
        let pageIndex = Math.floor(index / this._childrenPerPage);
        let pageOffset = pageIndex * this._childrenPerPage;

        let childrenPerRow = this._childrenPerPage / this._rowsPerPage;
        let sourceRow = Math.floor((index - pageOffset) / childrenPerRow);

        let nRowsAbove = (side == St.Side.TOP) ? sourceRow + 1
                                               : sourceRow;
        let nRowsBelow = this._maxRowsPerPage - nRowsAbove;

        // Since it always tries to show up the folder icon, then when only 1 row is
        // being displayed, the number of rows (to be moved out) here is 0; however
        // we override that because it's better to move the folder icon out of the
        // view than not showing the folder popup at all.
        if (nRows == 0)
            nRows = 1;

        let nRowsUp, nRowsDown;
        if (side == St.Side.TOP) {
            nRowsDown = Math.min(nRowsBelow, nRows);
            nRowsUp = nRows - nRowsDown;
        } else {
            nRowsUp = Math.min(nRowsAbove, nRows);
            nRowsDown = nRows - nRowsUp;
        }

        let childrenDown = children.splice(pageOffset +
                                           nRowsAbove * childrenPerRow,
                                           nRowsBelow * childrenPerRow);
        let childrenUp = children.splice(pageOffset,
                                         nRowsAbove * childrenPerRow);

        // Store the resulting calculations so that we can properly take
        // the open space when dragging icons over the icon grid from a
        // folder popup.
        this._extraSpaceData = [ sourceRow, nRowsUp, nRowsDown ];

        // Special case: On the last row with no rows below the icon,
        // there's no need to move any rows either up or down
        if (childrenDown.length == 0 && nRowsUp == 0) {
            this._translatedChildren = [];
            this.emit('space-opened');
        } else {
            this._translateChildren(childrenUp, Gtk.DirectionType.UP, nRowsUp);
            this._translateChildren(childrenDown, Gtk.DirectionType.DOWN, nRowsDown);
            this._translatedChildren = childrenUp.concat(childrenDown);
        }
    },

    _translateChildren: function(children, direction, nRows) {
        let translationY = nRows * (this._getVItemSize() + this._getSpacing());
        if (translationY == 0)
            return;

        if (direction == Gtk.DirectionType.UP)
            translationY *= -1;

        for (let i = 0; i < children.length; i++) {
            children[i].translation_y = 0;
            let params = { translation_y: translationY,
                           time: EXTRA_SPACE_ANIMATION_TIME,
                           transition: 'easeInOutQuad'
                         };
            if (i == (children.length - 1))
                params.onComplete = Lang.bind(this,
                    function() {
                        this.emit('space-opened');
                    });
            Tweener.addTween(children[i], params);
        }
    },

    closeExtraSpace: function() {
        if (!this._translatedChildren || !this._translatedChildren.length) {
            this._extraSpaceData = null;
            this.emit('space-closed');
            return;
        }

        for (let i = 0; i < this._translatedChildren.length; i++) {
            if (!this._translatedChildren[i].translation_y)
                continue;
            Tweener.addTween(this._translatedChildren[i],
                             { translation_y: 0,
                               time: EXTRA_SPACE_ANIMATION_TIME,
                               transition: 'easeInOutQuad'
                             });
        }

        // This is not entirely correct since we should ideally do
        // this on onComplete, but in our current implementation of
        // folders and DnD it can happen that the actor of the icons
        // we are moving back into their position get destroyed before
        // the tween completes (e.g. dragging icons out of folders),
        // meaning that the onComplete callback is never called, and
        // leaving this in an inconsistent state.
        //
        // As a temporary solution for now, let's assume that the folder
        // will be closed after EXTRA_SPACE_ANIMATION_TIME and reset the
        // status + emit the space-closed signal only once at that point.
        Mainloop.timeout_add_seconds(EXTRA_SPACE_ANIMATION_TIME * St.get_slow_down_factor(), () => {
            this._extraSpaceData = null;
            this.emit('space-closed');
            return GLib.SOURCE_REMOVE;
        });
    }
});
