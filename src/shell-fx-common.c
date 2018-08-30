/*
 * shell-fx-common.c
 *
 * Copyright © 2013-2018 Endless Mobile, Inc.
 *
 * This library is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation; either version 2 of the
 * licence or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library. If not, see <http://www.gnu.org/licenses/>.
 *
 * Authors: Sam Spilsbury <sam@endlessm.com>
 */

#include <clutter/clutter.h>
#include <math.h>

#include "shell-fx-common.h"

/* This constant is used to deal with rounding error in computing
 * paint boxes. See also https://gitlab.gnome.org/GNOME/mutter/blob/master/clutter/clutter/clutter-paint-volume.c#L1212 */
#define PAINT_BOX_OFFSET 1

/**
 * endless_shell_fx_get_untransformed_paint_box_from_existing_volume:
 * @actor: A #ClutterActor
 * @volume: A #ClutterPaintVolume
 * @box: (out caller-allocates): A #ClutterActorBox to write extents to
 *
 * Assuming that the paint volume is orthogonal, get the stage-relative 2D
 * extents of the paint volume and write them to the @box
 * out parameter.
 */
void
endless_shell_fx_get_untransformed_paint_box_from_existing_volume (ClutterActor             *actor,
                                                                   const ClutterPaintVolume *volume,
                                                                   ClutterActorBox          *box)
{
  ClutterVertex origin;

  /* We don't have access to the stage projection matrix
   * so the best we can do is hope here that the volume is
   * two dimensional and orthogonal. */
  clutter_paint_volume_get_origin (volume, &origin);

  box->x1 = floor (origin.x + clutter_actor_get_x (actor)) - PAINT_BOX_OFFSET;
  box->y1 = floor (origin.y + clutter_actor_get_y (actor)) - PAINT_BOX_OFFSET;
  box->x2 = box->x1 + ceil (clutter_paint_volume_get_width (volume)) + PAINT_BOX_OFFSET * 2;
  box->y2 = box->y1 + ceil (clutter_paint_volume_get_height (volume)) + PAINT_BOX_OFFSET * 2;
}

/**
 * endless_shell_fx_get_best_known_paint_extents_box:
 * @actor: A #ClutterActor
 * @box: (out caller-allocates): A #ClutterActorBox
 *
 * Get the paint box if possible, otherwise fall back to
 * using the actor geometry.
 */
void
endless_shell_fx_get_best_known_paint_extents_box (ClutterActor    *actor,
                                                   ClutterActorBox *box)
{
  float x, y, width, height;

  g_return_if_fail (box != NULL);

  if (clutter_actor_get_paint_box (actor, box))
    return;

  clutter_actor_get_position (actor, &x, &y);
  clutter_actor_get_size (actor, &width, &height);

  box->x1 = x;
  box->y1 = y;
  box->x2 = x + width;
  box->y2 = y + height;
}

/**
 * endless_shell_fx_compute_corners_from_paint_volume:
 * @actor: A #ClutterActor that we're computing corners for.
 * @volume: An existing #ClutterPaintVolume.
 * @out_corners: (out caller-allocates) (array fixed-size=4): An array
 *               of corners representing a 3D bounding plane for this
 *               paint area.
 * @offset: (out caller-allocates): A 2D vector representing the offset
 *          from the actor paint box corners to the real actor's real
 *          position.
 */
void
endless_shell_fx_compute_corners_from_untransformed_paint_volume (ClutterActor       *actor,
                                                                  ClutterPaintVolume *volume,
                                                                  AnimationVector    *out_corners,
                                                                  AnimationVector    *out_offset)
{
  ClutterActorBox box;
  float actor_x, actor_y;
  float actor_paint_box_x, actor_paint_box_y;
  float actor_paint_box_width, actor_paint_box_height;

  g_return_if_fail (out_corners != NULL);
  g_return_if_fail (out_offset != NULL);

  endless_shell_fx_get_untransformed_paint_box_from_existing_volume (actor, volume, &box);
  clutter_actor_get_position (actor, &actor_x, &actor_y);

  actor_paint_box_x = box.x1;
  actor_paint_box_y = box.y1;
  actor_paint_box_width = box.x2 - box.x1;
  actor_paint_box_height = box.y2 - box.y1;

  out_corners[0].x = actor_paint_box_x;
  out_corners[0].y = actor_paint_box_y;
  out_corners[1].x = actor_paint_box_x + actor_paint_box_width;
  out_corners[1].y = actor_paint_box_y;
  out_corners[2].x = actor_paint_box_x;
  out_corners[2].y = actor_paint_box_y + actor_paint_box_height;
  out_corners[3].x = actor_paint_box_x + actor_paint_box_width;
  out_corners[3].y = actor_paint_box_y + actor_paint_box_height;

  out_offset->x = actor_paint_box_x - actor_x;
  out_offset->y = actor_paint_box_y - actor_y;
}

/**
 * endless_shell_fx_expand_paint_volume_with_extremes:
 * @volume: A #ClutterPaintVolume
 * @extremes: (array fixed-size=4): An array
 *            of corners representing a 3D bounding plane for this
 *            paint area.
 * @offset: A 2D vector representing the offset from the actor paint
 *          box corners to the real actor's real position.
 */
void
endless_shell_fx_expand_paint_volume_with_extremes (ClutterPaintVolume *volume,
                                                    AnimationVector4D  *extremes,
                                                    AnimationVector    *offset)
{
  float x1, y1, x2, y2, z1, z2;

  g_return_if_fail (extremes != NULL);
  g_return_if_fail (offset != NULL);

  x1 = MIN (extremes[0].x, extremes[2].x) - offset->x;
  y1 = MIN (extremes[0].y, extremes[1].y) - offset->y;
  x2 = MAX (extremes[1].x, extremes[3].x) + offset->x;
  y2 = MAX (extremes[2].y, extremes[3].y) + offset->y;
  z1 = MIN (MIN (extremes[0].z, extremes[1].z),
            MIN (extremes[2].z, extremes[3].z));
  z2 = MAX (MAX (extremes[0].z, extremes[1].z),
            MAX (extremes[2].z, extremes[3].z));

  g_autoptr(ClutterPaintVolume) extremes_volume =
    clutter_paint_volume_copy (volume);

  ClutterVertex const origin = { x1, y1, z1 };
  clutter_paint_volume_set_origin (extremes_volume, &origin);
  clutter_paint_volume_set_width (extremes_volume, x2 - x1);
  clutter_paint_volume_set_height (extremes_volume, y2 - y1);
  clutter_paint_volume_set_depth (extremes_volume, z2 - z1);

  clutter_paint_volume_union (volume, extremes_volume);
}
