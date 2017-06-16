// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gtk = imports.gi.Gtk;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
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

var BaseIcon = new Lang.Class({
    Name: 'BaseIcon',

    _init : function(label, params) {
        params = Params.parse(params, { createIcon: null,
                                        createExtraIcons: null,
                                        setSizeManually: false,
                                        editable: false,
                                        showLabel: true });

        let styleClass = 'overview-icon';
        if (params.showLabel)
            styleClass += ' overview-icon-with-label';

        this.actor = new St.Bin({ style_class: styleClass,
                                  x_fill: true,
                                  y_fill: true });
        this.actor._delegate = this;
        this.actor.connect('style-changed',
                           Lang.bind(this, this._onStyleChanged));
        this.actor.connect('destroy',
                           Lang.bind(this, this._onDestroy));

        this._spacing = 0;

        let box = new Shell.GenericContainer();
        box.connect('allocate', Lang.bind(this, this._allocate));
        box.connect('get-preferred-width',
                    Lang.bind(this, this._getPreferredWidth));
        box.connect('get-preferred-height',
                    Lang.bind(this, this._getPreferredHeight));
        this.actor.set_child(box);

        this.iconSize = ICON_SIZE;
        this._iconBin = new St.Bin({ x_align: St.Align.MIDDLE,
                                     y_align: St.Align.MIDDLE });
        this._iconBin.add_style_class_name('icon-button');

        box.add_actor(this._iconBin);

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

        if (params.showLabel) {
            if (params.editable)
                this.label = new EditableLabel.EditableLabel({ text: label,
                                                               style_class: 'overview-icon-label' });
            else
                this.label = new St.Label({ text: label,
                                            style_class: 'overview-icon-label' });
            box.add_actor(this.label);
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

    _allocate: function(actor, box, flags) {
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;

        let iconSize = availHeight;

        let [iconMinHeight, iconNatHeight] = this._iconBin.get_preferred_height(-1);
        let [iconMinWidth, iconNatWidth] = this._iconBin.get_preferred_width(-1);
        let preferredHeight = iconNatHeight;

        let childBox = new Clutter.ActorBox();

        if (this.label) {
            let [labelMinHeight, labelNatHeight] = this.label.get_preferred_height(-1);
            preferredHeight += this._spacing + labelNatHeight;

            let labelHeight = availHeight >= preferredHeight ? labelNatHeight
                                                             : labelMinHeight;
            iconSize -= this._spacing + labelHeight;

            childBox.x1 = 0;
            childBox.x2 = availWidth;
            childBox.y1 = iconSize + this._spacing;
            childBox.y2 = childBox.y1 + labelHeight;
            this.label.allocate(childBox, flags);
        }

        childBox.x1 = Math.floor((availWidth - iconNatWidth) / 2);
        childBox.y1 = Math.floor((iconSize - iconNatHeight) / 2);
        childBox.x2 = childBox.x1 + iconNatWidth;
        childBox.y2 = childBox.y1 + iconNatHeight;
        this._iconBin.allocate(childBox, flags);
    },

    _getPreferredWidth: function(actor, forHeight, alloc) {
        this._getPreferredHeight(actor, -1, alloc);
    },

    _getPreferredHeight: function(actor, forWidth, alloc) {
        let [iconMinHeight, iconNatHeight] = this._iconBin.get_preferred_height(forWidth);
        alloc.min_size = iconMinHeight;
        alloc.natural_size = iconNatHeight;

        if (this.label) {
            let [labelMinHeight, labelNatHeight] = this.label.get_preferred_height(forWidth);
            alloc.min_size += this._spacing + labelMinHeight;
            alloc.natural_size += this._spacing + labelNatHeight;
        }
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

    _onStyleChanged: function() {
        let node = this.actor.get_theme_node();
        this._spacing = node.get_length('spacing');

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
        zoomOutActor(this.actor.child);
    },

    reloadIcon: function() {
        this._createIconTexture(this.iconSize);
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

    _init: function(params) {
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

        this.topPadding = 0;
        this.bottomPadding = 0;
        this.rightPadding = 0;
        this.leftPadding = 0;

        this.actor = new St.BoxLayout({ style_class: 'icon-grid',
                                        vertical: true });
        this._items = [];
        this._clonesAnimating = [];
        // Pulled from CSS, but hardcode some defaults here
        this._spacing = 0;
        this._hItemSize = this._vItemSize = ICON_SIZE;
        this._fixedHItemSize = this._fixedVItemSize = undefined;
        this._grid = new Shell.GenericContainer();
        this.actor.add(this._grid, { expand: true, y_align: St.Align.START });
        this.actor.connect('style-changed', Lang.bind(this, this._onStyleChanged));

        // Cancel animations when hiding the overview, to avoid icons
        // swarming into the void ...
        this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped)
                this._cancelAnimation();
        });

        this._grid.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this._grid.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this._grid.connect('allocate', Lang.bind(this, this._allocate));
        this._grid.connect('actor-added', Lang.bind(this, this._childAdded));
        this._grid.connect('actor-removed', Lang.bind(this, this._childRemoved));
    },

    _keyFocusIn: function(actor) {
        this.emit('key-focus-in', actor);
    },

    _childAdded: function(grid, child) {
        child._iconGridKeyFocusInId = child.connect('key-focus-in', Lang.bind(this, this._keyFocusIn));
    },

    _childRemoved: function(grid, child) {
        child.disconnect(child._iconGridKeyFocusInId);
    },

    _getPreferredWidth: function (grid, forHeight, alloc) {
        if (this._fillParent)
            // Ignore all size requests of children and request a size of 0;
            // later we'll allocate as many children as fit the parent
            return;

        let nChildren = this._grid.get_n_children();
        let nColumns = this._colLimit ? Math.min(this._colLimit,
                                                 nChildren)
                                      : nChildren;
        let totalSpacing = Math.max(0, nColumns - 1) * this._getSpacing();
        // Kind of a lie, but not really an issue right now.  If
        // we wanted to support some sort of hidden/overflow that would
        // need higher level design
        alloc.min_size = this._getHItemSize() + this.leftPadding + this.rightPadding;
        alloc.natural_size = nColumns * this._getHItemSize() + totalSpacing + this.leftPadding + this.rightPadding;
    },

    _getVisibleChildren: function() {
        let children = this._grid.get_children();
        children = children.filter(function(actor) {
            return actor.visible;
        });
        return children;
    },

    _getPreferredHeight: function (grid, forWidth, alloc) {
        if (this._fillParent)
            // Ignore all size requests of children and request a size of 0;
            // later we'll allocate as many children as fit the parent
            return;

        let children = this._getVisibleChildren();
        let nColumns;
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
        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _allocate: function (grid, box, flags) {
        if (this._fillParent) {
            // Reset the passed in box to fill the parent
            let parentBox = this.actor.get_parent().allocation;
            let gridBox = this.actor.get_theme_node().get_content_box(parentBox);
            box = this._grid.get_theme_node().get_content_box(gridBox);
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

        let x = box.x1 + leftEmptySpace + this.leftPadding;
        let y = box.y1 + this.topPadding;
        let columnIndex = 0;
        let rowIndex = 0;
        for (let i = 0; i < children.length; i++) {
            let childBox = this._calculateChildBox(children[i], x, y, box);

            if (this._rowLimit && rowIndex >= this._rowLimit ||
                this._fillParent && childBox.y2 > availHeight - this.bottomPadding) {
                this._grid.set_skip_paint(children[i], true);
            } else {
                children[i].allocate(childBox, flags);
                this._grid.set_skip_paint(children[i], false);
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

    _onStyleChanged: function() {
        let themeNode = this.actor.get_theme_node();
        this._spacing = themeNode.get_length('spacing');
        this._hItemSize = themeNode.get_length('-shell-grid-horizontal-item-size') || ICON_SIZE;
        this._vItemSize = themeNode.get_length('-shell-grid-vertical-item-size') || ICON_SIZE;
        this._grid.queue_relayout();
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
        this._grid.remove_all_children();
    },

    destroyAll: function() {
        this._items = [];
        this._grid.destroy_all_children();
    },

    addItem: function(item, index) {
        if (!item.icon instanceof BaseIcon)
            throw new Error('Only items with a BaseIcon icon property can be added to IconGrid');

        this._items.push(item);
        if (index !== undefined)
            this._grid.insert_child_at_index(item.actor, index);
        else
            this._grid.add_actor(item.actor);
    },

    removeItem: function(item) {
        this._grid.remove_child(item.actor);
    },

    getItemAtIndex: function(index) {
        return this._grid.get_child_at_index(index);
    },

    visibleItemsCount: function() {
        return this._grid.get_n_children() - this._grid.get_n_skip_paint();
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
    }
});
Signals.addSignalMethods(IconGrid.prototype);

var PaginatedIconGrid = new Lang.Class({
    Name: 'PaginatedIconGrid',
    Extends: IconGrid,

    _init: function(params) {
        this.parent(params);
        this._nPages = 0;
        this.currentPage = 0;
        this._rowsPerPage = 0;
        this._spaceBetweenPages = 0;
        this._childrenPerPage = 0;
    },

    _getPreferredHeight: function (grid, forWidth, alloc) {
        alloc.min_size = (this._availableHeightPerPageForItems() + this.bottomPadding + this.topPadding) * this._nPages + this._spaceBetweenPages * this._nPages;
        alloc.natural_size = (this._availableHeightPerPageForItems() + this.bottomPadding + this.topPadding) * this._nPages + this._spaceBetweenPages * this._nPages;
    },

    _allocate: function (grid, box, flags) {
         if (this._childrenPerPage == 0)
            log('computePages() must be called before allocate(); pagination will not work.');

        if (this._fillParent) {
            // Reset the passed in box to fill the parent
            let parentBox = this.actor.get_parent().allocation;
            let gridBox = this.actor.get_theme_node().get_content_box(parentBox);
            box = this._grid.get_theme_node().get_content_box(gridBox);
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

        let x = box.x1 + leftEmptySpace + this.leftPadding;
        let y = box.y1 + this.topPadding;
        let columnIndex = 0;
        let rowIndex = 0;

        for (let i = 0; i < children.length; i++) {
            let childBox = this._calculateChildBox(children[i], x, y, box);
            children[i].allocate(childBox, flags);
            this._grid.set_skip_paint(children[i], false);

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
        this._rowsPerPage = this.rowsForHeight(availHeightPerPage);
        this._nPages = Math.ceil(nRows / this._rowsPerPage);

        if (this._nPages > 1)
            this._spaceBetweenPages = availHeightPerPage - (this.topPadding + this.bottomPadding) - this._availableHeightPerPageForItems();
        else
            this._spaceBetweenPages = this._getSpacing();

        this._childrenPerPage = nColumns * this._rowsPerPage;
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
        let nRowsBelow = this._rowsPerPage - nRowsAbove;

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
            this.emit('space-closed');
            return;
        }

        for (let i = 0; i < this._translatedChildren.length; i++) {
            if (!this._translatedChildren[i].translation_y)
                continue;
            Tweener.addTween(this._translatedChildren[i],
                             { translation_y: 0,
                               time: EXTRA_SPACE_ANIMATION_TIME,
                               transition: 'easeInOutQuad',
                               onComplete: Lang.bind(this,
                                   function() {
                                       this.emit('space-closed');
                                   })
                             });
        }
    }
});
Signals.addSignalMethods(PaginatedIconGrid.prototype);
