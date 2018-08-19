/*
 * affine-effect.h
 *
 * Copyright © 2013-2016 Endless Mobile, Inc.
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

#ifndef ENDLESS_SHELL_FX_AFFINE_H
#define ENDLESS_SHELL_FX_AFFINE_H

#include <animation-glib/transform/transform.h>
#include <clutter/clutter.h>
#include <glib-object.h>

G_BEGIN_DECLS

#define ENDLESS_SHELL_FX_TYPE_AFFINE (endless_shell_fx_affine_get_type ())
G_DECLARE_FINAL_TYPE (EndlessShellFXAffine, endless_shell_fx_affine, ENDLESS_SHELL_FX, AFFINE, ClutterEffect)

/**
 * endless_shell_fx_affine_new:
 * @transform_animation: An #AnimationTransformAnimation to wrap.
 *
 * Creates a new #ClutterEffect which uses the underlying
 * AnimationZoomAnimation to apply a linear transformation to the actor.
 *
 * Returns: (transfer full): A new #ClutterEffect
 */
ClutterEffect * endless_shell_fx_affine_new (AnimationTransformAnimation *transform_animation);

G_END_DECLS

#endif
