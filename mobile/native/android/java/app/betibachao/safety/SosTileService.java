package app.betibachao.safety;

import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** Quick-settings tile ("Beti Bachao SOS") — pull down the notification shade and tap. */
public class SosTileService extends TileService {
    @Override
    public void onStartListening() {
        Tile t = getQsTile();
        if (t == null) return;
        t.setState(Tile.STATE_ACTIVE);
        t.setLabel("SOS");
        t.updateTile();
    }

    @Override
    public void onClick() {
        NativeSos.trigger(this, "tile");
    }
}
