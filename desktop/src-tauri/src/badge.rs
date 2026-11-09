//! The Inbox count on the app's taskbar / Dock icon, and flashing it when a
//! session needs you. The page says the count (a `badge/<n>` ask, updates.rs);
//! Windows takes a small image over the icon's corner (an overlay icon), so it is
//! drawn here: a red disc with the number, in a tiny built-in digit font, no
//! image files. macOS and Linux take the number itself.

/// What the badge says: nothing at 0, the number up to 9, then "9+".
pub fn badge_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// The overlay's size in pixels (Windows scales a 16×16 slot; 32 stays sharp at 200%).
pub const SIZE: usize = 32;

/// 3×5 glyphs, one row per byte, the high 3 bits of each the pixels left to right.
fn glyph(c: char) -> Option<[u8; 5]> {
    Some(match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => return None,
    })
}

const RED: [u8; 4] = [0xd9, 0x2d, 0x20, 0xff];
const WHITE: [u8; 4] = [0xff, 0xff, 0xff, 0xff];

/// The overlay image for a label: SIZE×SIZE RGBA, a red disc with the label in white, centred. Pure.
pub fn overlay_rgba(label: &str) -> Vec<u8> {
    let mut px = vec![0u8; SIZE * SIZE * 4];
    let put = |px: &mut Vec<u8>, x: usize, y: usize, c: [u8; 4]| {
        let i = (y * SIZE + x) * 4;
        px[i..i + 4].copy_from_slice(&c);
    };
    // The disc, with a soft edge (alpha by distance) so it isn't jagged.
    let r = SIZE as f32 / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 + 0.5 - r).powi(2) + (y as f32 + 0.5 - r).powi(2)).sqrt();
            let a = (r - d).clamp(0.0, 1.0);
            if a > 0.0 {
                put(&mut px, x, y, [RED[0], RED[1], RED[2], (a * 255.0) as u8]);
            }
        }
    }
    // The label: each glyph pixel a `scale`×`scale` block, one blank column between glyphs.
    let glyphs: Vec<[u8; 5]> = label.chars().filter_map(glyph).collect();
    if glyphs.is_empty() {
        return px;
    }
    let scale = if glyphs.len() == 1 { 4 } else { 3 };
    let width = (glyphs.len() * 4 - 1) * scale;
    let height = 5 * scale;
    let (x0, y0) = ((SIZE - width) / 2, (SIZE - height) / 2);
    for (gi, g) in glyphs.iter().enumerate() {
        for (row, bits) in g.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        put(&mut px, x0 + (gi * 4 + col) * scale + dx, y0 + row * scale + dy, WHITE);
                    }
                }
            }
        }
    }
    px
}

/// Show `count` on the window's taskbar / Dock icon (nothing at 0).
pub fn show(window: &tauri::WebviewWindow, count: u32) {
    #[cfg(windows)]
    {
        let icon = badge_label(count).map(|label| tauri::image::Image::new_owned(overlay_rgba(&label), SIZE as u32, SIZE as u32));
        let _ = window.set_overlay_icon(icon);
    }
    #[cfg(not(windows))]
    {
        let _ = window.set_badge_count(if count == 0 { None } else { Some(count as i64) });
    }
}

/// Flash the taskbar button / bounce the Dock icon once, unless the window is in front.
pub fn ask_attention(window: &tauri::WebviewWindow) {
    if window.is_focused().unwrap_or(false) {
        return;
    }
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(1).as_deref(), Some("1"));
        assert_eq!(badge_label(9).as_deref(), Some("9"));
        assert_eq!(badge_label(10).as_deref(), Some("9+"));
        assert_eq!(badge_label(4000).as_deref(), Some("9+"));
    }

    fn at(px: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * SIZE + x) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    #[test]
    fn the_overlay_is_a_red_disc_with_white_digits() {
        let px = overlay_rgba("4");
        assert_eq!(px.len(), SIZE * SIZE * 4);
        assert_eq!(at(&px, 0, 0)[3], 0, "the corners are clear");
        assert_eq!(at(&px, 3, SIZE / 2), RED, "the disc");
        let white = (0..SIZE * SIZE).filter(|i| px[i * 4..i * 4 + 4] == WHITE).count();
        // "4" lights 9 of its 15 cells, each a 4×4 block.
        assert_eq!(white, 9 * 16);
    }

    #[test]
    fn two_glyphs_fit_inside() {
        let px = overlay_rgba("9+");
        let white = (0..SIZE * SIZE).filter(|i| px[i * 4..i * 4 + 4] == WHITE).count();
        // "9" lights 12 cells and "+" 5, each a 3×3 block.
        assert_eq!(white, (12 + 5) * 9);
    }
}
